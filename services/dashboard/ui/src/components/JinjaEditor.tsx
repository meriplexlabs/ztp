import Editor from 'react-simple-code-editor'
import Prism from 'prismjs'

// Inline Jinja2 grammar — avoids Vite/ESM issues with prism component imports
Prism.languages['jinja2'] = {
  comment:   { pattern: /\{#[\s\S]*?#\}/,              greedy: true },
  tag:       { pattern: /\{%-?[\s\S]*?-?%\}/,          greedy: true, inside: {
    delimiter: { pattern: /^\{%-?|-?%\}$/ },
    keyword:   { pattern: /\b(if|elif|else|endif|for|endfor|block|endblock|extends|include|import|from|as|set|macro|endmacro|call|endcall|filter|endfilter|with|endwith|raw|endraw|not|and|or|in|is|recursive|super|loop|namespace|do)\b/ },
    string:    { pattern: /["'](?:[^"'\\]|\\.)*["']/, greedy: true },
    number:    /\b\d+\.?\d*\b/,
    operator:  /[|~]|[=!<>]=?/,
    punctuation: /[()[\]{}.,:]/,
    variable:  /[a-zA-Z_]\w*/,
  }},
  variable:  { pattern: /\{\{-?[\s\S]*?-?\}\}/,        greedy: true, inside: {
    delimiter: { pattern: /^\{\{-?|-?\}\}$/ },
    string:    { pattern: /["'](?:[^"'\\]|\\.)*["']/, greedy: true },
    number:    /\b\d+\.?\d*\b/,
    operator:  /[|~]|[=!<>]=?/,
    punctuation: /[()[\]{}.,:]/,
    name:      /[a-zA-Z_]\w*/,
  }},
}

const THEME = `
.jinja-editor-wrap { background:#1e1e2e; color:#cdd6f4; border-radius:0.375rem; }
.jinja-editor-wrap textarea,.jinja-editor-wrap pre { font-size:0.75rem!important; font-family:ui-monospace,SFMono-Regular,monospace!important; line-height:1.6!important; }
.jinja-editor-wrap .token.delimiter  { color:#89b4fa; font-weight:bold; }
.jinja-editor-wrap .token.keyword    { color:#cba6f7; font-weight:600; }
.jinja-editor-wrap .token.variable,.jinja-editor-wrap .token.name { color:#89dceb; }
.jinja-editor-wrap .token.string     { color:#a6e3a1; }
.jinja-editor-wrap .token.number     { color:#fab387; }
.jinja-editor-wrap .token.comment    { color:#6c7086; font-style:italic; }
.jinja-editor-wrap .token.operator   { color:#89b4fa; }
.jinja-editor-wrap .token.punctuation { color:#9399b2; }
`

let injected = false
function injectTheme() {
  if (injected) return
  injected = true
  const el = document.createElement('style')
  el.textContent = THEME
  document.head.appendChild(el)
}

function highlight(code: string): string {
  injectTheme()
  return Prism.highlight(code, Prism.languages['jinja2'], 'jinja2')
}

interface JinjaEditorProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}

export default function JinjaEditor({ value, onChange, placeholder }: JinjaEditorProps) {
  return (
    <div className="jinja-editor-wrap border rounded overflow-hidden focus-within:ring-2 focus-within:ring-primary/50">
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={highlight}
        padding={10}
        tabSize={2}
        insertSpaces
        placeholder={placeholder}
        style={{ minHeight: '24rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem' }}
        textareaClassName="focus:outline-none"
      />
    </div>
  )
}
