// Same boundary rules as kiro4cpa/kiro.rs: quoted tags are text; a closing
// tag needs a blank line, or whitespace through EOF. Extract at most once.
const quotes = "`\"'\\#!@$%^&*()-_=+[]{};:<>,.?/";
function boundary(text, tag, closing, final, previous = "") {
  for (let from = 0; ; ) {
    const at = text.indexOf(tag, from);
    if (at < 0) return -1;
    const after = at + tag.length,
      rest = text.slice(after);
    const before = at > 0 ? text[at - 1] : previous;
    if (
      !quotes.includes(before || "\0") &&
      !quotes.includes(text[after] || "\0") &&
      (closing
        ? rest.startsWith("\n\n") || (final && !rest.trim())
        : after < text.length || final)
    )
      return at;
    from = at + 1;
  }
}
export function parseThinking(s, text, final, append, close) {
  s.parser += text;
  while (s.parser) {
    if (!s.inThinking && s.extracted) {
      append("text", s.parser);
      s.parser = "";
      return;
    }
    if (s.inThinking && s.stripLeadNL) {
      s.parser = s.parser.replace(/^\n/, "");
      s.stripLeadNL = false;
    }
    const tag = s.inThinking ? "</thinking>" : "<thinking>",
      at = boundary(s.parser, tag, s.inThinking, final, s.parserPrevious);
    if (at >= 0) {
      const prefix = s.parser.slice(0, at);
      if (s.inThinking || prefix.trim())
        append(s.inThinking ? "thinking" : "text", prefix);
      s.parser = s.parser.slice(at + tag.length);
      if (s.inThinking) {
        s.parser = s.parser.startsWith("\n\n")
          ? s.parser.slice(2)
          : s.parser.replace(/^\s+/, "");
        s.inThinking = false;
        s.extracted = true;
        close();
      } else {
        s.inThinking = true;
        s.stripLeadNL = true;
        close();
      }
      s.parserPrevious = "";
      continue;
    }
    if (final) {
      append(s.inThinking ? "thinking" : "text", s.parser);
      s.parser = "";
      if (s.inThinking) {
        close();
        s.inThinking = false;
        s.extracted = true;
      }
      return;
    }
    const chars = Array.from(s.parser),
      cut = chars.length - (tag.length + 2);
    if (cut > 0) {
      const prefix = chars.slice(0, cut).join("");
      if (s.inThinking || prefix.trim()) {
        append(s.inThinking ? "thinking" : "text", prefix);
        s.parserPrevious = prefix.slice(-1);
        s.parser = chars.slice(cut).join("");
      }
    }
    return;
  }
}
