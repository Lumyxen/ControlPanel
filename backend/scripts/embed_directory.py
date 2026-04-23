import os
import sys


def sanitize_identifier(value):
    return "".join(ch if ch.isalnum() else "_" for ch in value)


def collect_files(input_dir):
    files = []
    if not os.path.isdir(input_dir):
        return files

    for root, dirnames, filenames in os.walk(input_dir):
        dirnames.sort()
        filenames.sort()
        for filename in filenames:
            file_path = os.path.join(root, filename)
            rel_path = os.path.relpath(file_path, input_dir).replace("\\", "/")
            var_name = "embedded_file_" + sanitize_identifier(rel_path)
            with open(file_path, "rb") as data_file:
                files.append((rel_path, var_name, data_file.read()))

    return files


def write_header(output_h, symbol_name):
    with open(output_h, "w", encoding="utf-8") as f:
        f.write("#pragma once\n#include <string_view>\n#include <unordered_map>\n\n")
        f.write(
            f"extern const std::unordered_map<std::string_view, std::string_view> {symbol_name};\n"
        )


def write_cpp(output_cpp, header_name, symbol_name, files):
    with open(output_cpp, "w", encoding="utf-8") as f:
        f.write(f'#include "{header_name}"\n\n')

        for rel_path, var_name, data in files:
            f.write(f"const unsigned char {var_name}[] = {{\n    ")
            hex_array = [f"0x{byte:02x}" for byte in data]
            hex_array.append("0x00")

            for index in range(0, len(hex_array), 16):
                f.write(", ".join(hex_array[index:index + 16]) + ",\n    ")
            f.write("};\n\n")

        f.write(
            f"const std::unordered_map<std::string_view, std::string_view> {symbol_name} = {{\n"
        )
        for rel_path, var_name, _ in files:
            f.write(
                f'    {{"{rel_path}", std::string_view(reinterpret_cast<const char*>({var_name}), sizeof({var_name}) - 1)}},\n'
            )
        f.write("};\n")


def main():
    if len(sys.argv) != 6:
        print(
            "Usage: embed_directory.py <input_dir> <output_h> <output_cpp> <header_name> <symbol_name>"
        )
        sys.exit(1)

    input_dir, output_h, output_cpp, header_name, symbol_name = sys.argv[1:6]
    files = collect_files(input_dir)
    write_header(output_h, symbol_name)
    write_cpp(output_cpp, header_name, symbol_name, files)


if __name__ == "__main__":
    main()
