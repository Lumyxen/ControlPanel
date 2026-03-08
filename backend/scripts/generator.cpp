#include <iostream>
#include <fstream>
#include <filesystem>
#include <string>
#include <vector>
#include <iomanip>

namespace fs = std::filesystem;

int main(int argc, char* argv[]) {
    if (argc != 4) {
        std::cerr << "Usage: " << argv[0] << " <input_dir> <output_h> <output_cpp>\n";
        return 1;
    }

    std::string input_dir = argv[1];
    std::string output_h = argv[2];
    std::string output_cpp = argv[3];

    std::ofstream h_out(output_h);
    std::ofstream cpp_out(output_cpp);

    h_out << "#pragma once\n#include <string_view>\n#include <unordered_map>\n\n";
    h_out << "extern const std::unordered_map<std::string_view, std::string_view> embedded_files;\n";

    cpp_out << "#include \"embedded_frontend.h\"\n\n";

    std::vector<std::pair<std::string, std::string>> files;

    for (const auto& entry : fs::recursive_directory_iterator(input_dir)) {
        if (entry.is_regular_file()) {
            std::string path = entry.path().string();
            std::string rel_path = path.substr(input_dir.length());
            for (char& c : rel_path) {
                if (c == '\\') c = '/';
            }
            if (rel_path.empty() || rel_path[0] != '/') {
                rel_path = "/" + rel_path;
            }

            std::string var_name = "file";
            for (char c : rel_path) {
                if (isalnum(c)) var_name += c;
                else var_name += '_';
            }

            files.push_back({rel_path, var_name});

            cpp_out << "const unsigned char " << var_name << "[] = {\n    ";

            std::ifstream in(path, std::ios::binary);
            int count = 0;
            unsigned char c;
            while (in.read(reinterpret_cast<char*>(&c), 1)) {
                cpp_out << "0x" << std::hex << std::setw(2) << std::setfill('0') << (int)c << ", ";
                count++;
                if (count == 16) {
                    cpp_out << "\n    ";
                    count = 0;
                }
            }
            cpp_out << "0x00\n};\n\n";
        }
    }

    cpp_out << "const std::unordered_map<std::string_view, std::string_view> embedded_files = {\n";
    for (const auto& f : files) {
        cpp_out << "    {\"" << f.first << "\", std::string_view(reinterpret_cast<const char*>(" << f.second << "), sizeof(" << f.second << ") - 1)},\n";
    }
    cpp_out << "};\n";

    return 0;
}