**Ultimate goal is to get a model like Qwen 3.5 2B in my AI harness to outperform Gemini 3.1 Pro in Google AI Studio in benchmarks**

# TODO
## Main Control Panel
### Planned Features
- Space mission views (ISS, Artemis II, easy additions for future Artemis missions)
- Advanced starry background for login page
- Photos page
  - APK for mobile auto-backup
    - GUI to customise stuff like end point and folders to back up
  - Executable files for desktop auto-backup
    - GUI to customise stuff like end point and folders to back up
  - Setting to change between full list and organised (split between selected folders)
  - Sorting stuff
- Cloud storage page
- Search bar functionality and UI with AI chat-box
- GitHub/GitLab/Codeberg/Directory LoC display

### Possible Features
- Post quantum encryption and hashing

### To Fix
#### UI
- None

#### UX
- None

#### Misc
- None

## AI Chat-box
### Planned Features
- Collapsable/Expandable BibTeX reference list
  - Closed it by default
- Download and Extracting progress bar on llama.cpp source downloading
- llama.cpp hardware usage configuration
- Tone down llama.cpp max compute usage to allow computer use during generation
  - Ability to return to maximum usage in settings
- Keep models loaded for 5 minutes after generation completion
  - Setting to change time to unload after generation completion, down to immediate (step before 1 minute), up to infinite (step after 30 minutes)
- KV cache reuse
- KV Quantisation
  - Reduce memory usage at the cost of decreasing context quality
- Button to go all the way to bottom of chat history
- Be able to scroll up and stop auto-scroll or scroll down and re-enter auto-scroll
- Center LaTeX formatting
  - Better live updating of the formatting
- Better model folder structure (each model has a directory containing .gguf, .mmproj, and .tiktoken/vocab.json)
- Edit available model list
  - Model search
    - LM Studio
    - HuggingFace (downloads model into ./data/models/)
      - Automatically finds the mmproj and vocab for the model.
      - Automatically converts gguf models into .rkllm on NPU build
  - Filters
- RKNN-LLM support to automatic backend inference software switching
- Add logprobs
  - Highlight uncertain tokens
- Speculative Decoding
  - Setting to enable/disable this
  - Setting to change both small and large models
- Speculative Speculative Decoding
  - Setting to enable/disable this
- Background AI generation (generates on the back-end, so switching chats or even closing the tab doesn't stop generation)
- AI generated chat title
- Tool calls inline in the text instead of being shoved at the top
  - Allow inlining inside of reasoning
- Rework settings page to have tabs
- Rating blocks (like claude.ai's rating blocks)
- Markdown formatting inside of thinking block
- Copy LaTeX image (copies image with transparent background showing the LaTeX formatting)
- Shift+Click to copy entire message including thinking block and tool calls
- Custom theme setting (list of variables and hex/rgb values)
- More animated UI during generation to give more livelihood to the chat-box
- Web search tool (custom made scraper)
- Add calculator tool (replaces code execution reliance for math)
  - WolframAlpha API option
- Turn the response into a back-and-forth for the AI.
  - Allow it to generate drafts, relook through the drafts, refine it, edit mistakes, and push the finalised result to the user
  - Show the user the live process of editing as the output so the user gets a sense of progression
- Do exact token counting instead of estimation
  - Show small warning under context window usage block when falling back to estimation because model's tokenisation is unknown
- Text showing model loading and prompt processing percentages and time
- RLM-like wrapper implementation for LLMs
  - Get more aggressive with offputting data into the long term context the closer you get to the maximum context window
  - Stage progression as: Full data -> summary + long term context -> long term context
  - Strengthen/weight information in the long term context the more it gets used to make it more likely/easy to be recalled in the future
    - Decay factor in the weighting
  - Offput large documents (12k+ tokens) to make the AI read in chunks to prevent context overflow and more effectively handle memory
- Headless browser tool
- Stop and restart backend options in the front-end, as Windows users likely won't use a terminal to run the app
##### Start giving updates to GamingwithNP
- Obsidian.md warning, danger, and check custom formatting
- Mobile UI support
- Add chat importing (from T3.chat & Google AI Studio)
- Add chat exporting (T3.chat format, custom format as default)
- Reserve max output token length to the context window (don't allow user to add more to the history if max output token length exceeds remaining available context)
- Add weather tool
  - Inputs user location on the current day by default
  - AI can specify a different location or date
  - Returns weather data and/or reports for that location and date
- Sort chat history by time since last chatted
- Diff formatting
- Change notice styling that back-end and/or an API connection is offline or lost
- Setting to change default model (already exists, but vastly improving on it)
- Ensure tool placeholder in global system prompt also returns description of each tool
- Be able to attach local directories
- Be able to attach ZIP files
  - Automatically unzip into being the same as if you were to upload a directory
    - Enabled non-local directory attaching
- Add sandboxed quick-code execution
- Add a sandboxed CLI tool
- Require user approval for if AI tries touchy commands (like `rm`)
- Add file reading tool
- Add searching agent tool
- Add sandboxed file editing tool
  - Restrained to set workspace directory
  - Remote editing, so for example, it could work on a project on duyfken despite running on skidbladnir
- Add file checkpoints before each AI file edit to ensure edits are reversable
- Allow the AI to attach files, allowing it to provide code updates with temp files without you having to copy an entire codeblock
- Add LSP support for generated code files
- Context message pinning (permanently remains in context window)
- Add a tool for the AI to call for another AI that would specialise in fact checking
- Add a tool for the AI to see the structure of the directory active directory (like tree but only shows current folder and path)
- Ability to manually send a message into RLM memory storage
- Add GitHub repo viewer tool
- Add personal per-chat notes tool for the AI to use
  - Capability for easy planning for the AI
- Add TODO list tool for the AI (similar but not the same to the notes tool)
- Different agents/personalities /w ability to customise things like system prompt
- Small governing AI to make sure it doesn't get malicious, call out possible hallucinations, call out yes-manning, and call out repetition glitching and auto-stop and regenerate the response (where the AI gets stuck in an infinite loop)
- Agent swarm tool (Democratic (models work together to form 1 final product) and Leadership (1 main orchestrating AI) versions)
- Deep research tool (responding only after finalising research after drafting, searching, calculating, etc)
- Summarise tool (spawns an AI to read the file and summarise it, returning the summary)
- Change tool list from system prompt into a centralised tool for the AI to search for available tools to use
- Internet testing tool
  - Returns if WAN is available
  - If so, the WAN speeds (a speed test), latency, and jitter
  - Returns local speeds, latency, and jitter (between the localhost ecosystem)
##### Start dogfooding the rest of AI stuff (programming)
- Step-by-Step thought graph (show different steps and decisions in a visual graph, like why it decided to skip research on a task)
- Tabbed chats (a top-bar to quickly change between chats instead of solely relying on the small side-bar chat navigatino)
- UI for thread management, replacing quick-action buttons on message hover
- UI for model selection instead of dropdown
- UI for tools instead of dropdown
- Smooth fade-in text streaming instead of sharp blocky streaming
- Smooth buttery typing and cursor (like monkeytype)
- Favicon
- Add message timestamps (visible to AI and user)
- Chat referencing (forwards/references entire chat)
- Cross-chat and same-chat message forwarding (forwards response and prompt)
- Allow editing of the model's thinking
- Add a time-since-last-token timer to let the user know if the AI froze or is working without directly checking output
- Add a time-since-first-token timer to let the user know how long the AI has been generating (resets when AI stops)
- Add AI message stats
  - Time from first to last token
  - Reason for stopping (EOS, User, Error)
  - Average tokens per second speed
    - Click for a graph, y=tps, x=time from first to last token
  - Latency from sending message to first token
  - Total tokens
- Add current tokens per second display (updated every 0.5s)
- Stats
  - Overall tokens generated and sent
  - Overall currently existing tokens generated and sent
  - Per chat overall tokens generated and sent
  - Per chat overall existing tokens generated and sent
  - Total generation time
  - Per chat total generation time
  - Total count of messages and responses
  - Per chat count of messages and responses
  - Total count of tool calls
  - Per chat count of tool calls
  - AI generating icon on chat listing
- Add tool for information exploration (can search for any device in my localhost ecosystem, currently only oseberge, skidbladnir, and duyfken)
  - OS type & version
  - OS age
  - Hardware
  - Kernel version
  - Software stuff
- VS Code like qualities in text (alt+up/down arrow to move line of text up/down text field lines)
- Ollama support
- Message staring per-chat and global
- Chat folders
- AI automated research (self-improvement)
  - Choose the best open sourced (actual open source, not open weight) model available
    - Train the AI for a set time (configurable, default 5 minutes)
    - Record score on benchmarks
  - Feed Qwen 3.5 35B A3B the results, making it try to improve it
    - If it doesn't improve, discard
    - If it improves, keep
  - Once Qwen 3.5 35B A3B feels it'd do worse then the AI it created at improving the AI, it hands that job to the AI
    - Continue going infinitely.
  - Greatly discourage scaling and encourage downscaling without performance loss
  - Encourage a liquid neural network type architecture to slowly involve into or take inspiration from
  - Do NOT let the initial Qwen 3.5 35B A3B model OR the trained AI to not be in this harness, as to give it up-most capabilities
  - Small model to keep watch unknowingly to the developer AI to kill the development loop as soon as any sort of malicious intent is detected
  - NOT meant to be computationally reasonable yet. It's for a preparation for when it does become reasonable, which is entirely unknown and could be tomorrow, or even 2 years from now.
- Always-On mode, asking a set AI model if there is anything worth doing every set amount of time, and then have it do such thing.
  - Log to keep track of what it noticed, what it decided, and what it did
  - Have it use git to be able to more directly target bad changes
- Automatic and local AI model benchmarking
  - Tool calling benchmark (tests how well it does tool calling when needed)
  - Factual information accuracy benchmark (tests the accuracy of information it provides)
  - Yes-man benchmark (tests if the AI will not agree on a wrong thing to please the user)
  - Bullshit benchmark (tests the willingness of the model to answer nonsensical questions)
  - Scaling benchmark (tests if the AI model will keep scaling intensity the more is added through multiple prompts versus all at once. e.g., User sends an initial message asking to rate something, goes past 10 messages, ends up with an 11/10 by the AI, whereas if it were all at once in the initial message, the AI would've given an 7/10)
  - Ego benchmark (tests the ego of the AI model)
  - IDK benchmark (tests the willingness of the model to say it doesn't know)
  - Censorship benchmark (tests the censorship and guardrails baked into the AI model)
  - Bias benchmark (tests the values and views baked into the AI model)
  - Oblivious benchmark (tests how oblivious AI model are by never trying to connect dots from previous chat history, only treating the chat history like knowledge instead of information)
  - TPS & TPS stability benchmark
  - Latency benchmark
  - Randomise questions via using a different AI model
    - Warn user if selected AI model is from the same company as the AI model being benchmarked

### Possible Features
- TurboQuant support
- Togglable SLM for detecting false/unwanted text processing (like Markdown)
- Setting to force thinking blocks on models that have thinking natively
- Support for an external llama.cpp server
- Token usage graph like Kilo Code
- Markdown and LaTeX processing in the input text field
- Detachment from browser (sepparate app)
- RLM memory 3d visualiser
- Negative Prompting (text field for AI to not do; e.g. "Do not apologize")
- Prompt A/B testing
- Browser Navigation (would need a small but capable vision model)
- Togglable full on code mode?
  - Store projects in, AI edits will go into new git branch until you approve it to be working and then merge it into master.
  - Preview mode for websites to start a web-server automatically and open a newtab on the web-server.
  - Diff applicator
  - Lines added and removed preview on chat list
  - LoC counter
    - Breaks down languages, comments, empty spaces, total lines of code

### To Fix
#### UI
- Build & Rebuild buttons are not equally sized
  - Rebuild and remove buttons should be bigger

#### UX
- LaTeX processing currently in an unfinished state
- The build history gets cut off in build output element
##### Firefox
- ESC does not properly cancel message editing, requiring 2 presses of ESC
  - AFAIK, this is unfixable, due to Firefox not providing the keyup or keydown signal for ESC if the key is bluring a text field or contenteditable field

#### Misc Bugs
- System Prompt does not count towards used up tokens

## Password Manager
### Planned Features
- None

### To Fix
#### UI
- None

#### UX
- None

#### Misc
- None

# Done
## Control Panel
### General
- Logging setup
- AES-256-GCM encryption on all stored data (other than settings) with 310.000 iteration key hashing
- Side bar
  - Collapsable
  - AI chat list (collapsable)
- Home page
- AI chat-box
- Settings page
  - Configuration for AI generation values such as
    - Default model
    - Max output tokens fallback
    - Temperature
    - System Prompt
    - llama.cpp build
      - CPU, Vulkan, CUDA, ROCm
  - Customisable theme between all Everforest palette choices and Catppuccin palette choices

## AI chat-box
- Message sending/generation
- Message threading
- Thinking/Reasoning support
- Generation chunk streaming
- Linux, Windows, and ARM support for back-end
  - Master binary with data being saved in ./data/
- Chat history
- Multiple chats
- Multiple API implementations
  - LM Studio Server
  - llama.cpp internal integration
    - Automatic detect optimal built llama.cpp builds
      - Can manually select builds instead
    - Popup to suggest a build when either none are built or the optimial one isn't built
      - Non-intrusive, can select to not show again
    - Settings section to build any type of build you want
      - Download and build progress indication including a mini console for output
- New chat button when sidebar is collapsed
- Message hover menu
  - AI message regeneration
  - Message editing (both user and AI messages)
  - Message copying (copies raw text, including formatting characters)
  - Message deletion
    - Creates new thread, deletes entire history to the deleted message alongside message
    - Shift+click to create a new thread and only delete the message instead of the chat history up to it too
  - New thread message
  - Thread navigation buttons (back & forth)
- Text processing
  - Hex, Hexa, and RGB value detectors to display a custom styled block with colour preview
  - Markdown
    - Base Markdown
      - Code block title bar /w copying & collapsing/expansion
    - Discord's Markdown features
    - Obsidian.md's Markdown features
  - LaTeX
    - Renderers
      - MathJax
      - KaTeX
      - HTML renderer
      - Image export
    - Engines
      - TeX Core
      - e-TeX Extensions
      - LaTeX 2ε
      - pdfTeX Extensions
      - ConTeXt Macros
      - Omega/Unicode Extensions
      - pTeX (Japanese typesetting)
    - Bibliography
      - BibTeX
    - Packages
      - amsmath
      - graphicx
      - hyperref
      - xcolor
      - booktabs
      - algorithm
      - TikZ
      - Beamer
      - Glossary & Index
    - Environments
      - Math (equation, align, gather, matrices, cases)
      - Text (lists, tables, verbatim, quotes)
      - Floats
      - Structural
    - Features
      - BibTeX
      - LaTeX callouts (24 types)
      - Syntax highlighting
      - Command autocomplete
      - Validation/linting
      - LaTeX to Markdown conversion
      - Cross-reference resolution
      - TOC generation
      - Live stream rendering
- Model selection dropdown
- Tool selection dropdown
- File attachments
  - Inline attachments
  - Image support
- Context used/max info
  - Context window highlighting (yellow @ 50%, red @ 90%)
  - Very fast and snappy live updating
- A master system prompt
  - Optimised for:
    - No yes-manning
    - Agentic tool usage
    - Agenting programming
    - Prevting hallucinations or guesses
- Config hot-reloading
- MCP support
