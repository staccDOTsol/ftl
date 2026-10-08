import { ScrollViewStyleReset } from 'expo-router/html'
import type { PropsWithChildren } from 'react'

// Web-only shell. Motion and focus states live here because React Native styles
// cannot express transitions, focus-visible or reduced-motion preferences.
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <meta name="theme-color" content="#0b0d12" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>{children}</body>
    </html>
  )
}

const CSS = `
html, body { background: #0b0d12; color-scheme: dark; }
body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
::selection { background: rgba(84, 243, 184, 0.28); }
::placeholder { color: rgba(140, 148, 165, 0.7); }
* { scrollbar-width: thin; scrollbar-color: rgba(120, 130, 150, 0.35) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-thumb { background: rgba(120, 130, 150, 0.35); border-radius: 8px; }
[role="button"], [role="tab"], [role="link"], a, button {
  transition: background-color 150ms cubic-bezier(.2,.8,.2,1), border-color 150ms cubic-bezier(.2,.8,.2,1),
              color 150ms cubic-bezier(.2,.8,.2,1), opacity 150ms cubic-bezier(.2,.8,.2,1),
              transform 120ms cubic-bezier(.2,.8,.2,1), box-shadow 200ms cubic-bezier(.2,.8,.2,1);
}
input, textarea { transition: border-color 150ms cubic-bezier(.2,.8,.2,1), box-shadow 200ms cubic-bezier(.2,.8,.2,1), background-color 150ms; }
input:focus-visible, textarea:focus-visible { outline: none !important; border-color: rgba(84, 243, 184, 0.75) !important; box-shadow: 0 0 0 3px rgba(84, 243, 184, 0.18); }
input[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: rgba(255, 120, 100, 0.8) !important; box-shadow: 0 0 0 3px rgba(255, 120, 100, 0.14); }
[role="button"]:focus-visible, [role="tab"]:focus-visible, [role="link"]:focus-visible, a:focus-visible { outline: 2px solid rgba(84, 243, 184, 0.9); outline-offset: 2px; }
[data-reveal] { animation: reveal 260ms cubic-bezier(.2,.8,.2,1) both; }
@keyframes reveal { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}
`
