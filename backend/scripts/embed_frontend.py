import os
import sys

def main():
    if len(sys.argv) != 4:
        print("Usage: embed_frontend.py <input_dir> <output_h> <output_cpp>")
        sys.exit(1)

    input_dir = sys.argv[1]
    output_h = sys.argv[2]
    output_cpp = sys.argv[3]

    with open(output_h, 'w', encoding='utf-8') as f:
        f.write("#pragma once\n#include <string_view>\n#include <unordered_map>\n\n")
        f.write("extern const std::unordered_map<std::string_view, std::string_view> embedded_files;\n")

    files =[]
    
    with open(output_cpp, 'w', encoding='utf-8') as f:
        f.write("#include \"embedded_frontend.h\"\n\n")
        
        for root, _, filenames in os.walk(input_dir):
            for filename in filenames:
                file_path = os.path.join(root, filename)
                rel_path = os.path.relpath(file_path, input_dir).replace('\\', '/')
                if not rel_path.startswith('/'):
                    rel_path = '/' + rel_path
                    
                var_name = "file_" + "".join(c if c.isalnum() else '_' for c in rel_path)
                files.append((rel_path, var_name))
                
                with open(file_path, 'rb') as data_file:
                    data = data_file.read()
                    
                f.write(f"const unsigned char {var_name}[] = {{\n    ")
                hex_array =[f"0x{b:02x}" for b in data]
                hex_array.append("0x00")
                
                for i in range(0, len(hex_array), 16):
                    f.write(", ".join(hex_array[i:i+16]) + ",\n    ")
                f.write("};\n\n")
                
        f.write("const std::unordered_map<std::string_view, std::string_view> embedded_files = {\n")
        for rel_path, var_name in files:
            f.write(f"    {{\"{rel_path}\", std::string_view(reinterpret_cast<const char*>({var_name}), sizeof({var_name}) - 1)}},\n")
        f.write("};\n")

if __name__ == "__main__":
    main()