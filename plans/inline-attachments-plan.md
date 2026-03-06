# Inline Attachments Feature Plan

## Overview

Implement inline file attachments that can be inserted at the cursor position within the text input, allowing users to intersperse text and attachments naturally.

## User Requirements

1. **Image attachments**: Large preview with smaller text showing details
2. **Non-image attachments**: File details with filetype icon/logo as mini preview (e.g., .jar shows jar logo)
3. **Removal**: Both backspace key and × button
4. **Reordering**: Move attachments like text (cut/paste) + Alt+Up/Down to shift selected content

## Current State

- Attachments are displayed in a separate area above the textarea
- File data is stored but attachments always appear at the beginning of messages
- Uses a standard `<textarea>` element which cannot contain inline elements

## Proposed Architecture

### 1. Input Field Transformation

Replace the `<textarea>` with a `<div contenteditable="true">` to support inline elements.

```
Before:                          After:
┌─────────────────────┐         ┌─────────────────────────────────┐
│ [attachment card]   │         │ Type text here...               │
│ [attachment card]   │   →     │ ┌──────────────────────┐         │
├─────────────────────┤         │ │ [large image preview]│         │
│ Type message...     │         │ │ filename.png  × 2MB  │         │
└─────────────────────┘         │ └──────────────────────┘         │
                                │ more text...                     │
                                │ ┌──────────────────────┐         │
                                │ │ 📦 JAR               │         │
                                │ │ plugin.jar  × 45KB   │         │
                                │ └──────────────────────┘         │
                                └─────────────────────────────────┘
```

### 2. Data Structure

Change message content from a simple string to a structured `parts` array:

```javascript
// Old structure
{
  content: "Some text\nAttachments:\n- file.txt (1KB)",
  attachments: [{ name, data, ... }]
}

// New structure
{
  parts: [
    { type: "text", content: "Here is a file: " },
    { type: "attachment", id: "att_123", name: "file.txt", data: "data:...", size: 1024, mimeType: "text/plain" },
    { type: "text", content: " and here is an image: " },
    { type: "attachment", id: "att_456", name: "image.png", data: "data:...", size: 2097152, mimeType: "image/png", isImage: true },
    { type: "text", content: " end of message." }
  ]
}
```

### 3. Implementation Steps

#### Step 1: HTML Changes
- Replace `<textarea id="chatInput">` with `<div id="chatInput" contenteditable="true">`
- Remove the separate `#chatAttachments` container
- Update `ai-chat.html`

#### Step 2: CSS Changes
- Style contenteditable div to look like the current textarea
- Create inline attachment chip styles:
  - **Image chips**: Large preview area with filename/size overlay
  - **File chips**: Smaller chip with filetype icon and details
- Add focus/hover states for attachment chips
- Ensure proper cursor behavior around chips

#### Step 3: JavaScript - Input Handling
- Create `InlineAttachmentManager` class to handle:
  - Inserting attachment chips at cursor position
  - Tracking attachment data associated with each chip
  - Handling backspace/delete to remove chips
  - Extracting content on submit
  - Alt+Up/Down to move content

#### Step 4: JavaScript - Content Extraction
- Parse contenteditable contents to extract parts array
- Handle text nodes and attachment chip elements
- Preserve cursor position information

#### Step 5: Graph/Store Updates
- Update node structure to use `parts` array instead of `content` + `attachments`
- Maintain backward compatibility with existing messages

#### Step 6: Thread UI Rendering
- Render parts in order
- Display inline attachments with appropriate styling
- Handle image previews inline

### 4. Key Technical Challenges

#### Contenteditable Caret Positioning
```javascript
// Insert element at cursor
function insertAtCursor(element) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(element);
  // Move cursor after element
  range.setStartAfter(element);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
```

#### Extracting Content
```javascript
function extractParts(contentEditableEl) {
  const parts = [];
  for (const child of contentEditableEl.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) {
        parts.push({ type: 'text', content: child.textContent });
      }
    } else if (child.dataset?.attachmentId) {
      parts.push({
        type: 'attachment',
        id: child.dataset.attachmentId,
        // ... attachment metadata
      });
    }
  }
  return parts;
}
```

#### Backspace Handling
- Detect when cursor is immediately after an attachment chip
- Select the entire chip on first backspace
- Remove chip on second backspace or delete

#### Alt+Up/Down Line/Element Movement
```javascript
function moveContent(direction) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  
  // Get the selected content or current line/element
  // Move it up or down within the contenteditable
  // This works for both text and attachment chips
}
```

### 5. File Structure Changes

```
ctrlpanel/
├── pages/
│   └── ai-chat.html        # Replace textarea with contenteditable
├── css/
│   └── chat.css            # Add inline chip styles
└── js/chat/
    ├── chat-page.js        # Update initUpload, form submit
    ├── inline-attachment.js # NEW: InlineAttachmentManager class
    ├── graph.js            # Support parts array in nodes
    ├── store.js            # Pass parts to addMessageToChat
    └── thread-ui.js        # Render parts in order
```

### 6. Backward Compatibility

- Existing messages with `content` string continue to work
- Convert old format to new format on load if needed
- Or render both formats appropriately

### 7. Visual Design

#### Image Attachment Chip (Large Preview)
```
┌─────────────────────────────────────────┐
│                                         │
│     [Large Image Preview Area]          │
│                                         │
├─────────────────────────────────────────┤
│ screenshot.png              ×      2.1MB│
└─────────────────────────────────────────┘
```

#### File Attachment Chip (Icon + Details)
```
┌─────────────────────────────────────────┐
│  ┌──────┐                               │
│  │      │  plugin.jar          ×   45KB │
│  │  📦  │  Java Archive                 │
│  │ JAR  │                               │
│  └──────┘                               │
└─────────────────────────────────────────┘
```

### 8. User Interactions

1. **Upload file** → Insert chip at current cursor position
2. **Backspace at chip** → Select chip first, then remove
3. **Click chip × button** → Remove chip
4. **Arrow keys** → Navigate through text and chips
5. **Alt+Up/Down** → Move selected content (text or attachment) up/down
6. **Cut/Copy/Paste** → Works with attachments like regular text

### 9. Filetype Icons

Need to create or source icons for common file types:
- Documents: PDF, DOC, DOCX, TXT, MD
- Code: JS, TS, PY, JAVA, JAR, JSON, HTML, CSS
- Archives: ZIP, TAR, GZ, RAR
- Media: MP3, MP4, WAV, AVI
- Images: PNG, JPG, GIF, SVG, WEBP (though these show previews)
- Generic: Unknown file type

### 10. Implementation Order

1. Create `inline-attachment.js` with core functionality
2. Update HTML to use contenteditable
3. Add CSS for attachment chips
4. Update `chat-page.js` to use new system
5. Update `graph.js` for parts array
6. Update `store.js` for parts handling
7. Update `thread-ui.js` for rendering
8. Add filetype icons
9. Implement Alt+Up/Down movement
10. Test and refine

---

## Additional Features

### 11. Markdown Parsing

Render markdown in message display (not in input field):

**Supported syntax:**
- Headers: `# H1`, `## H2`, `### H3`
- Bold: `**text**` or `__text__`
- Italic: `*text*` or `_text_`
- Strikethrough: `~~text~~`
- Code: `` `inline code` `` and ``` ```block code``` ```
- Links: `[text](url)`
- Images: `![alt](url)`
- Lists: `- item`, `1. item`
- Blockquotes: `> quote`
- Horizontal rules: `---`
- Tables: Simple table support

**Implementation:**
- Use a lightweight markdown parser (e.g., marked.js or custom)
- Sanitize HTML output for security
- Apply syntax highlighting for code blocks

### 12. LaTeX/Math Parsing

Render mathematical expressions:

**Syntax:**
- Inline: `$E = mc^2$`
- Block: `$$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$`

**Implementation:**
- Use KaTeX (lighter than MathJax)
- Parse on render, not on input
- Cache rendered output for performance

### 13. Performance Optimizations

#### Large Data Handling

**Virtual scrolling for message list:**
```javascript
// Only render visible messages
class VirtualScroller {
  constructor(container, itemHeight) {
    this.container = container;
    this.itemHeight = itemHeight;
    this.visibleStart = 0;
    this.visibleEnd = 0;
  }
  
  updateVisibleRange() {
    const scrollTop = this.container.scrollTop;
    const viewportHeight = this.container.clientHeight;
    this.visibleStart = Math.floor(scrollTop / this.itemHeight);
    this.visibleEnd = Math.ceil((scrollTop + viewportHeight) / this.itemHeight);
  }
}
```

**Lazy loading attachments:**
- Store attachment data in IndexedDB for large files
- Load attachment data on-demand when scrolling into view
- Use object URLs and revoke them when not needed

**Debounced input processing:**
```javascript
const debouncedExtract = debounce(extractParts, 100);
contentEditable.addEventListener('input', debouncedExtract);
```

#### Large Text Handling

**Text chunking for contenteditable:**
- Split very long text into manageable chunks
- Use `document.createDocumentFragment()` for batch DOM updates
- Avoid reflow-triggering operations during typing

**Efficient markdown/LaTeX rendering:**
- Cache parsed results
- Use Web Workers for heavy parsing
- Incremental rendering for long messages

**Memory management:**
```javascript
// Clean up object URLs when messages are removed
function cleanupMessage(node) {
  node.parts?.forEach(part => {
    if (part.type === 'attachment' && part.objectUrl) {
      URL.revokeObjectURL(part.objectUrl);
    }
  });
}
```

#### Rendering Optimizations

**RequestAnimationFrame batching:**
```javascript
function batchRender(items, renderFn) {
  const batch = items.slice(0, 50);
  batch.forEach(renderFn);
  if (items.length > 50) {
    requestAnimationFrame(() => batchRender(items.slice(50), renderFn));
  }
}
```

**Intersection Observer for lazy loading:**
```javascript
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      loadAttachmentData(entry.target);
      observer.unobserve(entry.target);
    }
  });
});
```

### 14. File Structure (Updated)

```
ctrlpanel/
├── pages/
│   └── ai-chat.html
├── css/
│   ├── chat.css
│   └── markdown.css        # NEW: Markdown/LaTeX styles
└── js/chat/
    ├── chat-page.js
    ├── inline-attachment.js # NEW
    ├── graph.js
    ├── store.js
    ├── thread-ui.js
    ├── markdown.js          # NEW: Markdown parser
    ├── latex.js             # NEW: LaTeX renderer
    └── virtual-scroller.js  # NEW: Virtual scrolling
```
