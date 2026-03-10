import os
import json
import subprocess
import argparse
from pathlib import Path
from typing import Dict, List, Tuple

BLACKLIST_FILES = frozenset([
    "login.html", "chat1.json", "chat2.json", "LICENSE"
])

BLACKLIST_FOLDERS = frozenset([
    "dev", ".vscode", ".git", "www", "third_party", "build", "testing"
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


def write_md_chunks(content: str, output_dir: Path, max_bytes: int = 9216000) -> List[Path]:
    """
    Split content into 90 KiB chunks and write to project.md (single) 
    or project1.md, project2.md, etc. (multiple).
    """
    lines = content.split('\n')
    chunks = []
    current_chunk = []
    current_size = 0
    
    for line in lines:
        line_with_newline = line + '\n'
        line_bytes = len(line_with_newline.encode('utf-8'))
        
        # Handle pathologically long lines (minified files)
        if line_bytes > max_bytes:
            if current_chunk:
                chunks.append(''.join(current_chunk))
                current_chunk = []
                current_size = 0
            
            # Split line into chunks
            for i in range(0, len(line), max_bytes):
                piece = line[i:i+max_bytes]
                if i + len(piece) < len(line):
                    chunks.append(piece)
                else:
                    current_chunk.append(piece + '\n')
                    current_size = len((piece + '\n').encode('utf-8'))
        
        elif current_size + line_bytes > max_bytes:
            if current_chunk:
                chunks.append(''.join(current_chunk))
            current_chunk = [line_with_newline]
            current_size = line_bytes
        else:
            current_chunk.append(line_with_newline)
            current_size += line_bytes
    
    if current_chunk:
        chunks.append(''.join(current_chunk))
    
    # Write files according to naming convention:
    # - Single chunk: project.md
    # - Multiple chunks: project1.md, project2.md, etc.
    written_files = []
    
    if len(chunks) == 1:
        output_file = output_dir / "project.md"
        output_file.write_text(chunks[0], encoding="utf-8")
        written_files.append(output_file)
    else:
        for i, chunk in enumerate(chunks, 1):
            filename = f"project{i}.md"
            output_file = output_dir / filename
            output_file.write_text(chunk, encoding="utf-8")
            written_files.append(output_file)
    
    return written_files


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


def restore_from_md(source_dir: Path, output_dir: Path) -> None:
    """Restore project structure from Markdown dump(s)."""
    # Check for single file first
    md_path = source_dir / "project.md"
    
    if md_path.exists():
        content = md_path.read_text(encoding="utf-8")
    else:
        # Look for numbered chunks: project1.md, project2.md, etc.
        md_files = sorted(
            source_dir.glob("project[0-9]*.md"),
            key=lambda p: int(p.stem[7:]) if p.stem[7:].isdigit() else 0
        )
        
        if not md_files:
            raise FileNotFoundError("No markdown dump files found")
        
        # Concatenate all chunks in order
        content = ""
        for md_file in md_files:
            content += md_file.read_text(encoding="utf-8")
    
    # Parse the concatenated content
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
        
        print(f"Dumping code from {target_dir}...")
        md_dump, json_dump = dump_code(target_dir)
        
        # Write JSON (always single file)
        output_json.write_text(json.dumps(json_dump, indent=2), encoding="utf-8")
        print(f"✓ JSON: {output_json}")
        
        # Write MD (split into 90 KiB chunks)
        md_files = write_md_chunks(md_dump, script_dir)
        for f in md_files:
            print(f"✓ MD:   {f}")
    
    else:
        # Restore mode
        output_dir = Path(args.output or script_dir / "restored_project").resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        
        json_path = script_dir / "project.json"
        
        print(f"Restoring project to {output_dir}...")
        
        try:
            if json_path.exists():
                print("Using JSON dump...")
                restore_from_json(json_path, output_dir)
            else:
                print("Using Markdown fallback...")
                restore_from_md(script_dir, output_dir)
            
            print(f"\n✓ Project restored to {output_dir}")
        except Exception as e:
            print(f"Error during restore: {e}")


if __name__ == "__main__":
    main()
