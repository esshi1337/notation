// Avoid allocating an array/string for every line and word on every keystroke.
export function documentCounts(text: string) {
  let lines = 1, words = 0, inWord = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10) lines++;
    const space = code === 32 || (code >= 9 && code <= 13)
      || (code > 127 && /\s/u.test(text[index]));
    if (!space && !inWord) words++;
    inWord = !space;
  }
  return { lines, words };
}
