#ifndef CLI_TOOL_H
#define CLI_TOOL_H

#include <string>
#include <vector>

#include <json/json.h>

namespace cli_tool {

struct RiskAssessment {
    bool requiresApproval = false;
    std::string riskTier = "read";
    std::string reason;
    std::vector<std::string> matchedTerms;

    Json::Value toJson() const;
};

RiskAssessment assessRisk(const Json::Value& arguments);

} // namespace cli_tool

#endif // CLI_TOOL_H
