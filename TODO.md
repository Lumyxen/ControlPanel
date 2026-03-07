# AI Chat-box
## Features
- System Prompt
- Code block copying
- Context window highlighting (yellow @ 50%, red @ 90%)
- Reserve max output token length to the context window (don't allow user to add more to the history if max output token length exceeds remaining available context)
- Allow editing of the model's thinking

## Possible Features
- Different agents/personalities /w ability to customise
- Token usage graph like Kilo Code

## To Fix
### UI
- Fix awkward sizing of OpenRouter API key status
- Fix large empty space in chats

### General Bugs
- Attachments don't count towards context window usage
- Messages flicker during longer generations that use auto-scroll
