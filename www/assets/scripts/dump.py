import os
import json
import subprocess
import argparse
from pathlib import Path
from typing import Dict, Tuple

BLACKLIST_FILES = frozenset([
    "gradlew"
])

BLACKLIST_FOLDERS = frozenset([
    "dev", ".git", ".vscode", ".gradle", ".idea", "dist", "test", 
    "build", "gradle"
])


def get_tree(directory: Path) -> str:
    """Generate directory tree using system 'tree' command."""
    try:
        return subprocess.check_output(
            ["tree", str(directory)], text=True, stderr=subprocess.DEVNULL
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return f"# Directory: {directory}\n"


def is_blacklisted(path: Path, root: Path) -> bool:
    """Check if path contains any blacklisted folder."""
    rel_parts = path.relative_to(root).parts
    return bool(BLACKLIST_FOLDERS & set(rel_parts))


def dump_code(directory: Path) -> Tuple[str, Dict]:
    """Extract all code files into JSON and Markdown format."""
    json_data = {}
    md_parts = [get_tree(directory), "\n"]
    
    for file_path in directory.rglob("*"):
        if not file_path.is_file():
            continue
        
        if file_path.name in BLACKLIST_FILES or is_blacklisted(file_path, directory):
            continue
        
        rel_path = file_path.relative_to(directory)
        
        # Build nested JSON structure
        curr = json_data
        for part in rel_path.parts[:-1]:
            curr = curr.setdefault(part, {})
        
        # Read file content
        try:
            code_content = file_path.read_text(encoding="utf-8")
        except Exception as e:
            code_content = f"Error reading file: {e}"
        
        file_type = file_path.suffix[1:] or "txt"
        curr[file_path.name] = {"type": file_type, "code": code_content}
        
        # Build markdown
        md_parts.extend([
            f"\n### ./{rel_path}:\n",
            f"```{file_type}\n{code_content}\n```\n"
        ])
    
    return "".join(md_parts), json_data


def restore_from_json(json_path: Path, output_dir: Path) -> None:
    """Restore project structure from JSON dump."""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    
    def traverse(obj: Dict, current_path: Path):
        for key, value in obj.items():
            target = current_path / key
            
            if isinstance(value, dict):
                if "type" in value and "code" in value:
                    # It's a file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(value["code"], encoding="utf-8")
                    print(f"  ✓ {target.relative_to(output_dir)}")
                else:
                    # It's a directory
                    target.mkdir(parents=True, exist_ok=True)
                    traverse(value, target)
    
    traverse(data, output_dir)


def restore_from_md(md_path: Path, output_dir: Path) -> None:
    """Restore project structure from Markdown dump (fallback)."""
    content = md_path.read_text(encoding="utf-8")
    lines = content.split("\n")
    
    current_file = None
    current_code = []
    in_code_block = False
    
    for line in lines:
        if line.startswith("### ./"):
            # Save previous file if exists
            if current_file and current_code:
                file_path = output_dir / current_file
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text("\n".join(current_code), encoding="utf-8")
                print(f"  ✓ {file_path.relative_to(output_dir)}")
            
            # Extract new file path
            current_file = line.split("### ./")[1].rstrip(":").strip()
            current_code = []
            in_code_block = False
        
        elif line.startswith("```") and current_file:
            if in_code_block:
                in_code_block = False
            else:
                in_code_block = True
        
        elif in_code_block and current_file:
            current_code.append(line)
    
    # Save last file
    if current_file and current_code:
        file_path = output_dir / current_file
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text("\n".join(current_code), encoding="utf-8")
        print(f"  ✓ {file_path.relative_to(output_dir)}")


def main():
    parser = argparse.ArgumentParser(description="Code dump and recovery tool")
    parser.add_argument(
        "mode", choices=["dump", "restore"], 
        help="dump: export code | restore: recover from dump"
    )
    parser.add_argument(
        "-d", "--directory", type=str,
        help="Target directory for dump or output for restore"
    )
    parser.add_argument(
        "-o", "--output", type=str, default=None,
        help="Output directory for restored files (restore mode only)"
    )
    
    args = parser.parse_args()
    script_dir = Path(__file__).parent
    
    if args.mode == "dump":
        # Dump mode
        if args.directory:
            target_dir = Path(args.directory).resolve()
        else:
            dir_input = input("Enter directory to dump (e.g. './'):\n> ")
            target_dir = (script_dir.parent / dir_input).resolve()
        
        if not target_dir.exists():
            print(f"Error: Directory '{target_dir}' does not exist!")
            return
        
        output_json = script_dir / "project.json"
        output_md = script_dir / "project.md"
        
        print(f"Dumping code from {target_dir}...")
        md_dump, json_dump = dump_code(target_dir)
        
        output_json.write_text(json.dumps(json_dump, indent=2), encoding="utf-8")
        output_md.write_text(md_dump, encoding="utf-8")
        
        print(f"✓ JSON: {output_json}")
        print(f"✓ MD:   {output_md}")
    
    else:
        # Restore mode
        output_dir = Path(args.output or script_dir / "restored_project").resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        
        json_path = script_dir / "project.json"
        md_path = script_dir / "project.md"
        
        print(f"Restoring project to {output_dir}...")
        
        try:
            if json_path.exists():
                print("Using JSON dump...")
                restore_from_json(json_path, output_dir)
            elif md_path.exists():
                print("Using Markdown fallback...")
                restore_from_md(md_path, output_dir)
            else:
                print("Error: No dump files found (project.json or project.md)")
                return
            
            print(f"\n✓ Project restored to {output_dir}")
        except Exception as e:
            print(f"Error during restore: {e}")


if __name__ == "__main__":
    main()
