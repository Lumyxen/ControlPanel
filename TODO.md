**Ultimate goal is to get a model like Qwen 3.5 2B to outperform Gemini 3.1 Pro in benchmarks**

# TODO
## Main Control Panel
### Features
- Search bar functionality and UI with AI chat-box

### To Fix
#### UX
- Put AI chat-box "new chat" button when sidebar is collapsed exclusively on AI chat-box pages

## AI Chat-box
### Planned Features
- Background AI generation (generates on the back-end, so switching chats or even closing the tab doesn't stop generation)
- Chat encryption (automatic decryption during chat loading)
- Web search tool
- Add calculator tool (replaces code execution reliance for math)
  - WolframAlpha API option
- Headless browser tool
##### Start giving updates to GamingwithNP
- Mobile UI support
- Migrate development onto skidbladnir to host it (not really a feature)
- Add llama.cpp server API support for local AI on skidbladnir
##### Start dogfooding for everyday questions
- Reserve max output token length to the context window (don't allow user to add more to the history if max output token length exceeds remaining available context)
- Be able to scroll up and stop auto-scroll
- Button to go all the way to bottom of chat history
- Add chat importing (from T3.chat & Google AI Studio)
- Add chat exporting (T3.chat format, custom format as default)
- Add logprobs
  - Highlight uncertain tokens
- Turn the response into a back-and-forth for the AI.
  - Allow it to generate drafts, relook through the drafts, refine it, edit mistakes, and push the finalised result to the user
  - Show the user the live process of editing as the output so the user gets a sense of progression
- RAG based memory
  - Only load or allow models to use 64k tokens max.
  - Get more aggressive with offputting data into the RAG DB the closer you get to the maximum context window
  - Stage progression as: Full data -> summary + RAG -> RAG
  - Strengthen/weight information in the RAG the more it gets used to make it more likely/easy to be recalled in the future
  - Allow the AI to switch to using an identifier that links to RAG memories to remember in the context window to remember to do specific tasks
  - Offput large documents (12k+ tokens) to make the AI read in chunks to prevent context overflow and more effectively handle memory
- Add weather tool
  - Inputs user location on the current day by default
  - AI can specify a different location or date
  - Returns weather data and/or reports for that location and date
- Sort chat history by time since last chatted
- Diff formatting
- Change notice styling that back-end and/or an API connection is offline or lost
- Setting to change default model (already exists, but vastly improving on it)
- Edit available model list
  - Model search
    - OpenRouter
    - LM Studio
    - HuggingFace
  - Filters
- Ensure tool placeholder in global system prompt also returns description of each tool
- Be able to attach local directories
- Be able to attach ZIP files
  - Automatically unzip into being the same as if you were to upload a directory
    - Enabled non-local directory attaching
- Add sandboxed quick-code execution
- Add a sandboxed CLI tool
- Require user approval for if AI tries touchy commands (like `rm`)
- Add file reading tool
- Add sandboxed file editing tool
  - Restrained to set workspace directory
  - Remote editing, so for example, it could work on a project on duyfken despite running on skidbladnir
- Add file checkpoints before each AI file edit to ensure edits are reversable
- Allow the AI to attach files, allowing it to provide code updates with temp files without you having to copy an entire codeblock
- Add LSP support for generated code files
- Context message pinning (permanently remains in context window)
- Add a tool for the AI to call for another AI that would specialise in fact checking
- Add a tool for the AI to see the structure of the directory active directory (like tree but only shows current folder and path)
- Ability to manually send a message into RAG memory storage
- Add GitHub repo viewer tool
- Add personal per-chat notes tool for the AI to use
  - Capability for easy planning for the AI
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
##### Start dogfooding for everything else with AI
- Step-by-Step thought graph (show different steps and decisions in a visual graph, like why it decided to skip research on a task)
- Rework settings page to have tabs
- Tabbed chats (a top-bar to quickly change between chats instead of solely relying on the small side-bar chat navigatino)
- UI for thread management, replacing quick-action buttons on message hover
- UI for model selection instead of dropdown
- UI for tools instead of dropdown
- Smooth fade-in text streaming instead of sharp blocky streaming
- Smooth buttery typing and cursor (like monkeytype)
- Add message timestamps to history
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
- Be able to pause/resume AI responses (may not be possible over OpenRouter)
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
- Message staring per-chat and global
- Chat folders
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
- Guide to how to setup a local AI model for new users
- Token usage graph like Kilo Code
- Markdown and LaTeX processing in the input text field
- Detachment from browser (sepparate app)
- RAG memory 3d visualiser
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
- Fix large empty space in chats
- LaTeX formatting not properly fully functional, but mostly is
- Messages flicker during longer generations that use auto-scroll

#### UX
- Fix new thread not being created when deleting a message
- Message shrinking/expanding unwantedly to strictly 2 lines when editing (make message editing properly size to original message size, expand/shrink with new/deleted lines)
- Fix ESC not canceling message editing and instead defocuses the text field on the first press
- Newline character collapsing into previous line with the sequence: character -> newline -> character -> delete character

#### General Bugs
- Randomly getting completion before any generation, causing no response
- Not properly getting context window size from LM Studio



# Done
## Control Panel
### General
- Side bar
  - Collapsable
  - AI chat list (collapsable)
- Home page
- AI chat-box
- Settings page
  - AI chat-box OpenRouter API key status
  - Configuration for AI generation values such as
    - Default model
    - Max output tokens fallback
    - Temperature
    - System Prompt
  - Customisable theme between all Everforest Palette choices and Catppuccin Palette choices

## AI chat-box
### General
- Message sending/generation
- Generation chunk streaming
- Linux & Windows support for back-end
  - Master binary with data being saved in ./data/
- Chat history
- Multiple chats
- Multiple API implementations
  - OpenRouter
  - LM Studio Server
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
  - Markdown
    - Base Markdown
      - Code block title bar /w copying & collapsing/expansion
    - Discord's Markdown features
    - Obsidian.md's Markdown features
  - LaTeX
- Model selection dropdown
- Tool selection dropdown
- File attachments
  - Inline attachments
- Context used/max info
  - Dynamically updates limits to what OpenRouter reports
  - Context window highlighting (yellow @ 50%, red @ 90%)
- A master system prompt
  - Optimised for:
    - No yes-manning
    - Agentic tool usage
    - Agenting programming
    - Prevting hallucinations or guesses
- Config hot-reloading
- MCP support