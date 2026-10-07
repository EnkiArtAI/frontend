/*
 * Porter stemmer (M. F. Porter, 1980), the classic five step algorithm.
 * Written here because nothing in node_modules stems, and a dependency for
 * eighty lines that never change would be one more thing to audit.
 *
 * Both sides of the search match go through it: the vocabulary's tags and
 * synonyms when the index is built, and the prompt text when it is scanned,
 * so "paintings" and "painting" meet at "paint".
 */

const c = "[^aeiou]";
const v = "[aeiouy]";
const C = `${c}[^aeiouy]*`;
const V = `${v}[aeiou]*`;

const mgr0 = new RegExp(`^(${C})?${V}${C}`);
const meq1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
const mgr1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
const hasVowel = new RegExp(`^(${C})?${v}`);
const cvcNotWxy = new RegExp(`^${C}${v}[^aeiouwxy]$`);

const STEP2: Record<string, string> = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize",
  bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous", ization: "ize",
  ation: "ate", ator: "ate", alism: "al", iveness: "ive", fulness: "ful",
  ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble", logi: "log",
};
const STEP3: Record<string, string> = {
  icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "",
};
const STEP2_RE = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const STEP3_RE = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const STEP4_RE = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
const STEP4_ION_RE = /^(.+?)([st])ion$/;

export function stem(word: string): string {
  if (word.length < 3) return word;
  const startsWithY = word[0] === "y";
  let w = startsWithY ? `Y${word.slice(1)}` : word;

  // 1a: plurals
  if (/^(.+?)(ss|i)es$/.test(w)) w = w.replace(/^(.+?)(ss|i)es$/, "$1$2");
  else if (/^(.+?)([^s])s$/.test(w)) w = w.replace(/^(.+?)([^s])s$/, "$1$2");

  // 1b: -eed, -ed, -ing
  let m = /^(.+?)eed$/.exec(w);
  if (m) {
    if (mgr0.test(m[1])) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w)) && hasVowel.test(m[1])) {
    w = m[1];
    if (/(at|bl|iz)$/.test(w)) w += "e";
    else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
    else if (cvcNotWxy.test(w)) w += "e";
  }

  // 1c: y -> i
  if ((m = /^(.+?)y$/.exec(w)) && hasVowel.test(m[1])) w = `${m[1]}i`;

  // 2
  if ((m = STEP2_RE.exec(w)) && mgr0.test(m[1])) w = m[1] + STEP2[m[2]];

  // 3
  if ((m = STEP3_RE.exec(w)) && mgr0.test(m[1])) w = m[1] + STEP3[m[2]];

  // 4
  if ((m = STEP4_RE.exec(w))) {
    if (mgr1.test(m[1])) w = m[1];
  } else if ((m = STEP4_ION_RE.exec(w)) && mgr1.test(m[1] + m[2])) {
    w = m[1] + m[2];
  }

  // 5
  if ((m = /^(.+?)e$/.exec(w)) && (mgr1.test(m[1]) || (meq1.test(m[1]) && !cvcNotWxy.test(m[1])))) w = m[1];
  if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);

  return startsWithY ? `y${w.slice(1)}` : w;
}
