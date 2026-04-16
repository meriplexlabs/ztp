import Editor from 'react-simple-code-editor'
import Prism from 'prismjs'
import 'prismjs/components/prism-markup-templating'
import 'prismjs/components/prism-twig'

// Minimal dark theme matching the app's monospace style
const THEME = `
.jinja-editor { background:#1e1e2e; color:#cdd6f4; font-size:0.75rem; font-family:ui-monospace,monospace; min-height:24rem; border-radius:0.375rem; }
.jinja-editor .token.tag,.jinja-editor .token.delimiter { color:#89b4fa; }
.jinja-editor .token.keyword { color:#cba6f7; font-weight:600; }
.jinja-editor .token.variable { color:#89dceb; }
.jinja-editor .token.string { color:#a6e3a1; }
.jinja-editor .token.number { color:#fab387; }
.jinja-editor .token.comment { color:#585b70; font-style:italic; }
.jinja-editor .token.operator { color:#89b4fa; }
.jinja-editor .token.punctuation { color:#cdd6f4; }
`

let injected = false
function injectTheme() {
  if (injected) return
  injected = true
  const el = document.createElement('style')
  el.textContent = THEME
  document.head.appendChild(el)
}

function highlight(code: string) {
  injectTheme()
  return Prism.highlight(code, Prism.languages['twig'], 'twig')
}

interface JinjaEditorProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}

export default function JinjaEditor({ value, onChange, placeholder }: JinjaEditorProps) {
  return (
    <div className="border rounded overflow-hidden focus-within:ring-2 focus-within:ring-primary/50">
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={highlight}
        padding={10}
        tabSize={2}
        insertSpaces
        placeholder={placeholder}
        className="jinja-editor"
        style={{ minHeight: '24rem', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem' }}
        textareaClassName="focus:outline-none"
      />
    </div>
  )
}
