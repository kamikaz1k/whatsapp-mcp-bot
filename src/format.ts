// The model writes Markdown; WhatsApp has its own small syntax and no hyperlinks. This
// turns a reply into WhatsApp text: web-search citations dropped, [text](url) links reduced
// to their text, **bold** and headings made *bold*, tracking parameters cut off URLs.
// Bare URLs stay (WhatsApp makes them tappable), so sources can still be asked for.

const LINK = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g
/** "([example.com](https://…))" or several, as web search cites them. */
const CITATION_GROUP = /[ \t]*\(\s*\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)(?:\s*[,;]\s*\[[^\]\n]*\]\(https?:\/\/[^\s)]+\))*\s*\)/g
const TRACKING = /([?&])utm_[a-z]+=[^&\s#)]*&?/gi

function looksLikeSource(text: string): boolean {
  const t = text.trim().toLowerCase()
  return !t || /^(source|sources|link|\d+)$/.test(t) || /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(t)
}

function cleanUrl(url: string): string {
  return url.replace(TRACKING, "$1").replace(/[?&]$/, "")
}

function prose(text: string): string {
  return (
    text
      .replace(CITATION_GROUP, "")
      // A link that's only a source label goes; any other keeps its words.
      .replace(LINK, (_match, label: string) => (looksLikeSource(label) ? "" : label))
      .replace(/https?:\/\/[^\s)>\]]+/g, cleanUrl)
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "_$1_")
      .replace(/~~(.+?)~~/g, "~$1~")
      .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_match, title: string) => `*${title.replace(/^\*(.*)\*$/, "$1")}*`)
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
      // What removing citations leaves behind: "word ." and "()" and double spaces.
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]+([.,;:!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/gm, "")
  )
}

/**
 * The URLs a reply cites in [text](url) form, which whatsappText removes. They're kept
 * apart so a later "sources?" in reply to the answer can still get them.
 */
export function citedUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const piece of text.split(/```[\s\S]*?```/)) {
    for (const match of piece.matchAll(LINK)) urls.add(cleanUrl(match[2]!))
  }
  return [...urls].slice(0, 20)
}

/** A reply as WhatsApp text. Code blocks are left alone. */
export function whatsappText(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((piece, index) => (index % 2 === 1 ? piece : prose(piece)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
