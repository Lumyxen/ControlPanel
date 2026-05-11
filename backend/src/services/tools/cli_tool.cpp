#include "services/tools/cli_tool.h"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

std::string trimCopy(const std::string& value) {
    const auto start = value.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(start, end - start + 1);
}

std::string toLower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

bool isShellSeparator(const std::string& token) {
    return token == ";" || token == "|" || token == "||" || token == "&&" ||
           token == "&" || token == "(" || token == ")";
}

bool isAssignment(const std::string& token) {
    const auto pos = token.find('=');
    if (pos == std::string::npos || pos == 0) {
        return false;
    }
    for (std::size_t i = 0; i < pos; ++i) {
        const unsigned char ch = static_cast<unsigned char>(token[i]);
        if (!(std::isalnum(ch) || token[i] == '_')) {
            return false;
        }
    }
    return true;
}

bool isOption(const std::string& token) {
    return token.size() > 1 && token[0] == '-';
}

std::string commandName(std::string token) {
    token = toLower(trimCopy(token));
    const auto slash = token.find_last_of("/\\");
    if (slash != std::string::npos) {
        token = token.substr(slash + 1);
    }
    return token;
}

std::vector<std::string> tokenizeShellForRisk(const std::string& command) {
    std::vector<std::string> tokens;
    std::string current;
    bool singleQuoted = false;
    bool doubleQuoted = false;
    bool escaped = false;

    auto pushCurrent = [&]() {
        if (!current.empty()) {
            tokens.push_back(current);
            current.clear();
        }
    };

    for (std::size_t i = 0; i < command.size(); ++i) {
        const char ch = command[i];

        if (escaped) {
            current.push_back(ch);
            escaped = false;
            continue;
        }

        if (singleQuoted) {
            if (ch == '\'') {
                singleQuoted = false;
            } else {
                current.push_back(ch);
            }
            continue;
        }

        if (doubleQuoted) {
            if (ch == '"') {
                doubleQuoted = false;
            } else if (ch == '\\') {
                escaped = true;
            } else {
                current.push_back(ch);
            }
            continue;
        }

        if (ch == '\\') {
            escaped = true;
            continue;
        }
        if (ch == '\'') {
            singleQuoted = true;
            continue;
        }
        if (ch == '"') {
            doubleQuoted = true;
            continue;
        }
        if (std::isspace(static_cast<unsigned char>(ch))) {
            pushCurrent();
            continue;
        }

        if (ch == ';' || ch == '(' || ch == ')' || ch == '<' || ch == '>') {
            pushCurrent();
            std::string token(1, ch);
            if (i + 1 < command.size() && command[i + 1] == ch && (ch == '<' || ch == '>')) {
                token.push_back(command[++i]);
            }
            tokens.push_back(token);
            continue;
        }

        if (ch == '|' || ch == '&') {
            pushCurrent();
            std::string token(1, ch);
            if (i + 1 < command.size() && command[i + 1] == ch) {
                token.push_back(command[++i]);
            }
            tokens.push_back(token);
            continue;
        }

        current.push_back(ch);
    }

    if (escaped) {
        current.push_back('\\');
    }
    pushCurrent();
    return tokens;
}

void addMatch(std::vector<std::string>& matches, const std::string& value) {
    if (value.empty()) {
        return;
    }
    if (std::find(matches.begin(), matches.end(), value) == matches.end()) {
        matches.push_back(value);
    }
}

bool isDestructiveCommand(const std::string& command) {
    static const std::unordered_set<std::string> commands = {
        "rm",
        "rmdir",
        "unlink",
        "shred",
        "truncate",
        "dd",
        "wipefs",
        "fdisk",
        "sfdisk",
        "cfdisk",
        "parted",
        "partprobe",
        "mkswap",
    };
    return commands.find(command) != commands.end() || command.rfind("mkfs", 0) == 0;
}

bool isMutatingCommand(const std::string& command) {
    static const std::unordered_set<std::string> commands = {
        "chmod",
        "chown",
        "chgrp",
        "cp",
        "install",
        "ln",
        "mkdir",
        "mv",
        "patch",
        "tee",
        "touch",
    };
    return commands.find(command) != commands.end();
}

bool isShellCommand(const std::string& command) {
    static const std::unordered_set<std::string> commands = {
        "bash",
        "dash",
        "fish",
        "sh",
        "zsh",
    };
    return commands.find(command) != commands.end();
}

bool isCommandWrapper(const std::string& command) {
    static const std::unordered_set<std::string> commands = {
        "command",
        "env",
        "nice",
        "nohup",
        "sudo",
        "time",
    };
    return commands.find(command) != commands.end();
}

std::size_t nextCommandIndexAfterWrapper(const std::vector<std::string>& tokens, std::size_t index) {
    for (std::size_t i = index + 1; i < tokens.size(); ++i) {
        if (isShellSeparator(tokens[i])) {
            return tokens.size();
        }
        if (isAssignment(tokens[i])) {
            continue;
        }
        if (isOption(tokens[i])) {
            const std::string option = tokens[i];
            if ((option == "-u" || option == "-g" || option == "-C" || option == "-T") && i + 1 < tokens.size()) {
                ++i;
            }
            continue;
        }
        return i;
    }
    return tokens.size();
}

std::size_t nextNonOptionIndex(const std::vector<std::string>& tokens, std::size_t index) {
    for (std::size_t i = index + 1; i < tokens.size(); ++i) {
        if (isShellSeparator(tokens[i])) {
            return tokens.size();
        }
        if (isOption(tokens[i]) || isAssignment(tokens[i])) {
            continue;
        }
        return i;
    }
    return tokens.size();
}

void inspectCommandAt(
    const std::vector<std::string>& tokens,
    std::size_t index,
    std::vector<std::string>& matches,
    bool& destructive,
    int depth);

void inspectShellSnippet(
    const std::string& snippet,
    std::vector<std::string>& matches,
    bool& destructive,
    int depth) {
    if (depth >= 3 || trimCopy(snippet).empty()) {
        return;
    }
    const std::vector<std::string> nested = tokenizeShellForRisk(snippet);
    bool expectCommand = true;
    for (std::size_t i = 0; i < nested.size(); ++i) {
        if (isShellSeparator(nested[i])) {
            expectCommand = true;
            continue;
        }
        if (!expectCommand || isAssignment(nested[i])) {
            continue;
        }
        inspectCommandAt(nested, i, matches, destructive, depth + 1);
        expectCommand = false;
    }
}

void inspectFindCommand(
    const std::vector<std::string>& tokens,
    std::size_t index,
    std::vector<std::string>& matches,
    bool& destructive) {
    for (std::size_t i = index + 1; i < tokens.size(); ++i) {
        if (isShellSeparator(tokens[i])) {
            break;
        }
        const std::string token = commandName(tokens[i]);
        if (token == "-delete") {
            addMatch(matches, "find -delete");
            destructive = true;
            continue;
        }
        if ((token == "-exec" || token == "-execdir") && i + 1 < tokens.size()) {
            const std::string execCommand = commandName(tokens[i + 1]);
            if (isDestructiveCommand(execCommand)) {
                addMatch(matches, "find " + token + " " + execCommand);
                destructive = true;
            } else if (isMutatingCommand(execCommand)) {
                addMatch(matches, "find " + token + " " + execCommand);
            }
        }
    }
}

void inspectGitCommand(
    const std::vector<std::string>& tokens,
    std::size_t index,
    std::vector<std::string>& matches,
    bool& destructive) {
    const std::size_t subcommandIndex = nextNonOptionIndex(tokens, index);
    if (subcommandIndex >= tokens.size()) {
        return;
    }

    const std::string subcommand = commandName(tokens[subcommandIndex]);
    static const std::unordered_set<std::string> destructiveSubcommands = {
        "checkout",
        "clean",
        "reset",
        "restore",
    };
    static const std::unordered_set<std::string> mutatingSubcommands = {
        "am",
        "apply",
        "cherry-pick",
        "commit",
        "merge",
        "rebase",
        "stash",
        "switch",
    };

    if (destructiveSubcommands.find(subcommand) != destructiveSubcommands.end()) {
        addMatch(matches, "git " + subcommand);
        destructive = true;
    } else if (mutatingSubcommands.find(subcommand) != mutatingSubcommands.end()) {
        addMatch(matches, "git " + subcommand);
    }
}

void inspectPackageManagerCommand(
    const std::vector<std::string>& tokens,
    std::size_t index,
    std::vector<std::string>& matches) {
    const std::string manager = commandName(tokens[index]);
    const std::size_t subcommandIndex = nextNonOptionIndex(tokens, index);
    if (subcommandIndex >= tokens.size()) {
        return;
    }

    const std::string subcommand = commandName(tokens[subcommandIndex]);
    static const std::unordered_set<std::string> mutatingSubcommands = {
        "add",
        "ci",
        "i",
        "install",
        "remove",
        "uninstall",
        "update",
        "upgrade",
    };
    if (mutatingSubcommands.find(subcommand) != mutatingSubcommands.end()) {
        addMatch(matches, manager + " " + subcommand);
    }
}

void inspectXargsCommand(
    const std::vector<std::string>& tokens,
    std::size_t index,
    std::vector<std::string>& matches,
    bool& destructive,
    int depth) {
    std::size_t commandIndex = tokens.size();
    for (std::size_t i = index + 1; i < tokens.size(); ++i) {
        if (isShellSeparator(tokens[i])) {
            break;
        }
        const std::string token = tokens[i];
        if (isOption(token)) {
            if ((token == "-a" || token == "--arg-file" ||
                 token == "-d" || token == "--delimiter" ||
                 token == "-E" || token == "-e" || token == "--eof" ||
                 token == "-I" || token == "-i" || token == "--replace" ||
                 token == "-L" || token == "-l" || token == "--max-lines" ||
                 token == "-n" || token == "--max-args" ||
                 token == "-P" || token == "--max-procs" ||
                 token == "-s" || token == "--max-chars") &&
                i + 1 < tokens.size()) {
                ++i;
            }
            continue;
        }
        commandIndex = i;
        break;
    }
    if (commandIndex < tokens.size()) {
        inspectCommandAt(tokens, commandIndex, matches, destructive, depth + 1);
    }
}

void inspectCommandAt(
    const std::vector<std::string>& tokens,
    std::size_t index,
    std::vector<std::string>& matches,
    bool& destructive,
    int depth) {
    if (index >= tokens.size()) {
        return;
    }

    const std::string command = commandName(tokens[index]);
    if (command.empty()) {
        return;
    }

    if (isCommandWrapper(command)) {
        const std::size_t nestedIndex = nextCommandIndexAfterWrapper(tokens, index);
        if (nestedIndex < tokens.size()) {
            inspectCommandAt(tokens, nestedIndex, matches, destructive, depth + 1);
        }
        return;
    }

    if (isDestructiveCommand(command)) {
        addMatch(matches, command);
        destructive = true;
        return;
    }

    if (isMutatingCommand(command)) {
        addMatch(matches, command);
    }

    if (isShellCommand(command)) {
        for (std::size_t i = index + 1; i + 1 < tokens.size(); ++i) {
            if (isShellSeparator(tokens[i])) {
                break;
            }
            if (tokens[i] == "-c") {
                inspectShellSnippet(tokens[i + 1], matches, destructive, depth + 1);
                break;
            }
        }
        return;
    }

    if (command == "find") {
        inspectFindCommand(tokens, index, matches, destructive);
        return;
    }

    if (command == "git") {
        inspectGitCommand(tokens, index, matches, destructive);
        return;
    }

    if (command == "xargs") {
        inspectXargsCommand(tokens, index, matches, destructive, depth);
        return;
    }

    static const std::unordered_set<std::string> packageManagers = {
        "npm",
        "pnpm",
        "yarn",
        "pip",
        "pip3",
    };
    if (packageManagers.find(command) != packageManagers.end()) {
        inspectPackageManagerCommand(tokens, index, matches);
    }
}

std::vector<std::string> collectRiskMatches(const std::string& command, bool& destructive) {
    std::vector<std::string> matches;
    const std::vector<std::string> tokens = tokenizeShellForRisk(command);
    bool expectCommand = true;

    for (std::size_t i = 0; i < tokens.size(); ++i) {
        const std::string& token = tokens[i];
        if (isShellSeparator(token)) {
            expectCommand = true;
            continue;
        }
        if (token == ">" || token == ">>" || token == "<>") {
            addMatch(matches, token == ">>" ? "append redirection" : "output redirection");
            expectCommand = false;
            continue;
        }
        if (!expectCommand || isAssignment(token)) {
            continue;
        }

        inspectCommandAt(tokens, i, matches, destructive, 0);
        expectCommand = false;
    }

    return matches;
}

std::string joinMatches(const std::vector<std::string>& matches) {
    std::ostringstream stream;
    for (std::size_t i = 0; i < matches.size(); ++i) {
        if (i > 0) {
            stream << ", ";
        }
        stream << matches[i];
    }
    return stream.str();
}

std::vector<std::string> withoutNetworkMatch(const std::vector<std::string>& matches) {
    std::vector<std::string> result;
    for (const auto& match : matches) {
        if (match != "network access") {
            result.push_back(match);
        }
    }
    return result;
}

} // namespace

Json::Value cli_tool::RiskAssessment::toJson() const {
    Json::Value result(Json::objectValue);
    result["requires_approval"] = requiresApproval;
    result["risk_tier"] = riskTier;
    result["reason"] = reason;
    result["matched_terms"] = Json::Value(Json::arrayValue);
    for (const auto& term : matchedTerms) {
        result["matched_terms"].append(term);
    }
    return result;
}

cli_tool::RiskAssessment cli_tool::assessRisk(const Json::Value& arguments) {
    RiskAssessment assessment;
    const std::string command = arguments.get("command", "").asString();
    const bool allowNetwork =
        arguments.isObject() &&
        arguments.isMember("allow_network") &&
        arguments["allow_network"].isBool() &&
        arguments["allow_network"].asBool();

    bool destructive = false;
    assessment.matchedTerms = collectRiskMatches(command, destructive);

    if (allowNetwork) {
        addMatch(assessment.matchedTerms, "network access");
    }

    assessment.requiresApproval = allowNetwork || !assessment.matchedTerms.empty();
    assessment.riskTier = destructive ? "destructive" : (assessment.requiresApproval ? "write" : "read");

    const std::vector<std::string> operationMatches = withoutNetworkMatch(assessment.matchedTerms);
    if (allowNetwork && operationMatches.empty()) {
        assessment.reason = "Sandboxed CLI command requests network access.";
    } else if (allowNetwork) {
        assessment.reason = "Sandboxed CLI command requests network access and uses touchy shell operation(s): " +
            joinMatches(operationMatches) + ".";
    } else if (!assessment.matchedTerms.empty()) {
        assessment.reason = "Sandboxed CLI command uses touchy shell operation(s): " +
            joinMatches(assessment.matchedTerms) + ".";
    }

    return assessment;
}
