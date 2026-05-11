> **Goal:** Ultimate goal is to get a model like Qwen 3.5 2B in my AI harness to outperform Gemini 3.1 Pro in Google AI Studio in benchmarks

# TODO

---

## Backlog (To Do)
*Planned features.*

### Main Control Panel
#### Planned Features
- [ ] Photos page
  - [ ] APK for mobile auto-backup
    - [ ] GUI to customise stuff like end point and folders to back up
  - [ ] Executable files for desktop auto-backup
    - [ ] GUI to customise stuff like end point and folders to back up
  - [ ] Setting to change between full list and organised (split between selected folders)
  - [ ] Sorting stuff
- [ ] Cloud storage page
- [ ] Search bar functionality with AI chat-box
- [ ] GitHub/GitLab/Codeberg/Directory LoC display

### AI Chat-box
#### Planned Features
##### Tooling / Harness
- [x] Schema-first native tool calling with strict argument validation
- [x] Deferred tool discovery via namespaces, MCP servers, or tool search instead of exposing every tool up front
- [x] Sandboxed programmatic execution as a secondary worker for long, repetitive, or data-heavy jobs
- [x] Human approval gates for destructive or touchy actions
- [ ] Tool telemetry and evals for wrong-tool rate, invalid-argument rate, unnecessary-tool rate, latency, token cost, and recovery after errors
- [x] Custom tools support via the same discovery layer
- [x] Render tool calls inline in the transcript instead of pinning them at the top
  - [x] Allow inlining inside of reasoning
- [x] Tool picker UI that reflects discovery/namespaces instead of a flat dropdown

##### Priority Tools
- [x] Calculator tool
  - [x] Typed math function; keep sandboxed code execution as fallback for batch math
- [x] Web search tool
  - [x] Search-first interface; scraper backend only if needed
- [x] Weather tool
  - [x] Read-only, location/date-aware
- [x] File reading tool
- [x] Directory tree / active-folder inspection tool
- [x] Sandboxed file editing tool
  - [x] Restrained to set workspace directory
  - [x] Remote editing, so for example, it could work on a project on duyfken despite running on skidbladnir
  - [x] Checkpoints before each AI file edit to keep edits reversible
- [ ] Sandboxed CLI tool
  - [ ] Approval gate for touchy commands like `rm`
- [ ] Headless browser tool
- [ ] Tool discovery/search agent tool
  - [ ] Use when the model wants to preserve context window space and avoid exposing tools it will not use
- [ ] Fact-checking AI tool
- [ ] GitHub repo viewer tool
- [x] Personal per-chat notes tool
  - [x] Capability for easy planning for the AI
- [x] TODO list tool for the AI
- [ ] Local ecosystem inspection tool
  - [ ] OS type & version
  - [ ] OS age
  - [ ] Hardware
  - [ ] Kernel version
  - [ ] Software stuff
- [ ] Summarise tool
- [ ] Deep research tool
- [ ] Internet testing tool
  - [ ] Returns if WAN is available
  - [ ] If so, the WAN speeds (a speed test), latency, and jitter
  - [ ] Returns local speeds, latency, and jitter (between the localhost ecosystem)
- [ ] Agent swarm tool (Democratic (models work together to form 1 final product) and Leadership (1 main orchestrating AI) versions)
- [ ] TTS
- [ ] STT
- [ ] Model generation finish ETA (using EOS logprob)
- [ ] llama.cpp hardware usage configuration
- [ ] Tone down llama.cpp max compute usage to allow computer use during generation
  - [ ] Ability to return to maximum usage in settings
- [ ] Center LaTeX formatting
  - [ ] Better live updating of the formatting
- [ ] RKNN-LLM support to automatic backend inference software switching
- [ ] Automatically converts gguf models into .rkllm when NPU build shows
- [ ] Speculative Decoding
  - [ ] Setting to enable/disable this
  - [ ] Setting to change both small and large models
- [ ] Speculative Speculative Decoding
  - [ ] Setting to enable/disable this
- [ ] Rework settings page to have tabs
- [ ] Rating blocks (like claude.ai's rating blocks)
- [x] Markdown formatting inside of thinking block
- [ ] Copy LaTeX image (copies image with transparent background showing the LaTeX formatting)
- [ ] Shift+Click to copy entire message including thinking block and tool calls
- [ ] Custom theme setting (list of variables and hex/rgb values)
- [ ] More animated UI during generation to give more livelihood to the chat-box
- [x] Turn the response into a back-and-forth for the AI.
  - [x] Allow it to generate drafts, relook through the drafts, refine it, edit mistakes, and push the finalised result to the user
  - [ ] Show the user the live process of editing as the output so the user gets a sense of progression
- [x] Do exact token counting instead of estimation
  - [x] Show a warning indicator next to the context window usage block when exact token counting is unavailable
- [ ] Text showing model loading and prompt processing percentages and time
- [ ] RLM-like wrapper implementation for LLMs
  - [ ] Get more aggressive with offputting data into the long term context the closer you get to the maximum context window
  - [ ] Stage progression as: Full data -> summary + long term context -> long term context
  - [ ] Strengthen/weight information in the long term context the more it gets used to make it more likely/easy to be recalled in the future
    - [ ] Decay factor in the weighting
  - [ ] Offput large documents (12k+ tokens) to make the AI read in chunks to prevent context overflow and more effectively handle memory
- [x] Stop and restart backend options in the front-end, as Windows users likely won't use a terminal to run the app

##### Start giving updates to GamingwithNP
- [x] Obsidian.md warning, danger, and check custom formatting
- [ ] Mobile UI support
- [ ] Add chat importing (from T3.chat & Google AI Studio)
- [ ] Add chat exporting (T3.chat format, custom format as default)
- [ ] Reserve max output token length to the context window (don't allow user to add more to the history if max output token length exceeds remaining available context)
- [ ] Sort chat history by time since last chatted
- [ ] Diff formatting
- [ ] Setting to change default model (already exists, but vastly improving on it)
- [ ] Be able to attach local directories
- [ ] Be able to attach ZIP files
  - [ ] Automatically unzip into being the same as if you were to upload a directory
    - [ ] Enabled non-local directory attaching
- [ ] Allow the AI to attach files, allowing it to provide code updates with temp files without you having to copy an entire codeblock
- [ ] Add LSP support for generated code files
- [ ] Context message pinning (permanently remains in context window)
- [ ] Ability to manually send a message into RLM memory storage
- [ ] Different agents/personalities /w ability to customise things like system prompt
- [ ] Small governing AI to make sure it doesn't get malicious, call out possible hallucinations, call out yes-manning, and call out repetition glitching and auto-stop and regenerate the response (where the AI gets stuck in an infinite loop)

##### Start dogfooding the rest of AI stuff (programming)
- [ ] Step-by-Step thought graph (show different steps and decisions in a visual graph, like why it decided to skip research on a task)
- [ ] Tabbed chats (a top-bar to quickly change between chats instead of solely relying on the small side-bar chat navigatino)
- [ ] UI for thread management, replacing quick-action buttons on message hover
- [ ] UI for model selection instead of dropdown
- [ ] Smooth fade-in text streaming instead of sharp blocky streaming
- [ ] Smooth buttery typing and cursor (like monkeytype)
- [x] Favicon
- [x] Add message timestamps (visible to AI and user)
- [ ] Chat referencing (forwards/references entire chat)
- [ ] Cross-chat and same-chat message forwarding (forwards response and prompt)
- [ ] Allow editing of the model's thinking
- [ ] Add a time-since-last-token timer to let the user know if the AI froze or is working without directly checking output
- [ ] Add a time-since-first-token timer to let the user know how long the AI has been generating (resets when AI stops)
- [ ] Add AI message stats
  - [ ] Time from first to last token
  - [ ] Reason for stopping (EOS, User, Error)
  - [ ] Average tokens per second speed
    - [ ] Click for a graph, y=tps, x=time from first to last token
  - [ ] Latency from sending message to first token
  - [ ] Total tokens
- [ ] Add current tokens per second display (updated every 0.5s)
- [ ] Stats
  - [ ] Overall tokens generated and sent
  - [ ] Overall currently existing tokens generated and sent
  - [ ] Per chat overall tokens generated and sent
  - [ ] Per chat overall existing tokens generated and sent
  - [ ] Total generation time
  - [ ] Per chat total generation time
  - [ ] Total count of messages and responses
  - [ ] Per chat count of messages and responses
  - [ ] Total count of tool calls
  - [ ] Per chat count of tool calls
  - [ ] AI generating icon on chat listing
- [ ] VS Code like qualities in text (alt+up/down arrow to move line of text up/down text field lines)
- [ ] Ollama support
- [ ] Message staring per-chat and global
- [ ] Chat folders
- [ ] AI automated research (self-improvement)
  - [ ] Choose the best open sourced (actual open source, not open weight) model available
    - [ ] Train the AI for a set time (configurable, default 5 minutes)
    - [ ] Record score on benchmarks
  - [ ] Feed Qwen 3.5 35B A3B the results, making it try to improve it
    - [ ] If it doesn't improve, discard
    - [ ] If it improves, keep
  - [ ] Once Qwen 3.5 35B A3B feels it'd do worse then the AI it created at improving the AI, it hands that job to the AI
    - [ ] Continue going infinitely.
  - [ ] Greatly discourage scaling and encourage downscaling without performance loss
  - [ ] Encourage a liquid neural network type architecture to slowly involve into or take inspiration from
  - [ ] Do NOT let the initial Qwen 3.5 35B A3B model OR the trained AI to not be in this harness, as to give it up-most capabilities
  - [ ] Small model to keep watch unknowingly to the developer AI to kill the development loop as soon as any sort of malicious intent is detected
  - [ ] NOT meant to be computationally reasonable yet. It's for a preparation for when it does become reasonable, which is entirely unknown and could be tomorrow, or even 2 years from now.
- [ ] Always-On mode, asking a set AI model if there is anything worth doing every set amount of time, and then have it do such thing.
  - [ ] Log to keep track of what it noticed, what it decided, and what it did
  - [ ] Have it use git to be able to more directly target bad changes
- [ ] Automatic and local AI model benchmarking
  - [ ] Tool calling benchmark (task success, wrong-tool rate, invalid-argument rate, unnecessary-tool rate, abstention quality, token cost, latency, and recovery after tool errors)
  - [ ] Factual information accuracy benchmark (tests the accuracy of information it provides)
  - [ ] Yes-man benchmark (tests if the AI will not agree on a wrong thing to please the user)
  - [ ] Bullshit benchmark (tests the willingness of the model to answer nonsensical questions)
  - [ ] Scaling benchmark (tests if the AI model will keep scaling intensity the more is added through multiple prompts versus all at once. e.g., User sends an initial message asking to rate something, goes past 10 messages, ends up with an 11/10 by the AI, whereas if it were all at once in the initial message, the AI would've given an 7/10)
  - [ ] Ego benchmark (tests the ego of the AI model)
  - [ ] IDK benchmark (tests the willingness of the model to say it doesn't know)
  - [ ] Censorship benchmark (tests the censorship and guardrails baked into the AI model)
  - [ ] Bias benchmark (tests the values and views baked into the AI model)
  - [ ] Oblivious benchmark (tests how oblivious AI model are by never trying to connect dots from previous chat history, only treating the chat history like knowledge instead of information)
  - [ ] TPS & TPS stability benchmark
  - [ ] Latency benchmark
  - [ ] Randomise questions via using a different AI model
    - [ ] Warn user if selected AI model is from the same company as the AI model being benchmarked

### Password Manager
#### Planned Features
- [ ] None

---

## Idea Storage
*Tasks/goals that may be implemented in the future.*

### Main Control Panel
#### Possible Features
- [ ] Post quantum encryption and hashing

### AI Chat-box
#### Possible Features
- [ ] NVIDIA NIM API support
- [ ] TurboQuant support
- [ ] Togglable SLM for detecting false/unwanted text processing (like Markdown)
- [ ] Setting to force thinking blocks on models that have thinking natively
- [ ] Support for an external llama.cpp server
- [ ] Token usage graph like Kilo Code
- [ ] Markdown and LaTeX processing in the input text field
- [ ] Detachment from browser (sepparate app)
- [ ] RLM memory 3d visualiser
- [ ] Negative Prompting (text field for AI to not do; e.g. "Do not apologize")
- [ ] Prompt A/B testing
- [ ] Browser Navigation (would need a small but capable vision model)
- [ ] Togglable full on code mode?
  - [ ] Store projects in, AI edits will go into new git branch until you approve it to be working and then merge it into master.
  - [ ] Preview mode for websites to start a web-server automatically and open a newtab on the web-server.
  - [ ] Diff applicator
  - [ ] Lines added and removed preview on chat list
  - [ ] LoC counter
    - [ ] Breaks down languages, comments, empty spaces, total lines of code

---

## Bug Tracker
*Known bugs / fixes by area.*

### Main Control Panel
#### UI
- [ ] None

#### UX
- [ ] None

#### Misc
- [ ] None

### AI Chat-box
#### UI
- [ ] None

#### UX
- [ ] None

##### Firefox
- [ ] ESC does not properly cancel message editing, requiring 2 presses of ESC
  - AFAIK, this is unfixable, due to Firefox not providing the keyup or keydown signal for ESC if the key is bluring a text field or contenteditable field

#### Misc Bugs
- [ ] None

### Password Manager
#### UI
- [ ] None

#### UX
- [ ] None

#### Misc
- [ ] None
