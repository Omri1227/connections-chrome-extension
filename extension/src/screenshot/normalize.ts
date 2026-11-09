// Fixes the usual OCR confusions in the few shapes that matter (times, airport codes, flight numbers) and nothing
// else. Every change is recorded on the word (`corrected` = what was read), so the field it ends up in is shown to the
// traveller as "check" — a correction is a guess, never a silent fact.
import { isKnownAirport } from '../core/airports.ts';
import type { OcrWord } from './types.ts';

const DIGIT: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', g: '9' };
const LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G', '4': 'A' };
/** Airline brand names written in capitals that are also airport codes, when followed by more of the airline's name. */
const AIRLINE_WORDS = new Set(['TAP', 'LOT', 'SAS', 'KLM', 'ANA', 'JAL', 'EVA', 'AUA', 'ITA']);
const digits = (s: string) => s.replace(/[^0-9]/g, (c) => DIGIT[c] ?? c);

const TIMEISH = /^([0-2OoIl|]?[0-9OoIlSB|])([:;.,])([0-5OoIlSBD][0-9OoIlSBDZz|])(?:[  ]?([AaPp]\.?[Mm]\.?))?([+*]\s?[1-3lI|])?([,.;'"`°^*]*)$/;

export function normalizeWord(w: OcrWord): OcrWord {
  const t = w.text;
  // stand-alone day marker "+1" (superscript read separately)
  if (/^[+*][1-3lI|]$/.test(t)) return t === '+1' || t === '+2' || t === '+3' ? w : { ...w, text: `+${digits(t.slice(1))}`, corrected: t };
  const m = TIMEISH.exec(t);
  if (m) {
    const hh = digits(m[1]), mm = digits(m[3]);
    const twoDigitHour = m[1].length === 2;
    const sepOk = m[2] === ':' || m[2] === ';' || twoDigitHour;   // "08.15" is a time, "3.12" is not
    if (sepOk && /^\d{1,2}$/.test(hh) && /^\d{2}$/.test(mm) && Number(hh) <= 23 && Number(mm) <= 59) {
      const ampm = m[4] ? m[4].replace(/\./g, '').toUpperCase() : '';
      const plus = m[5] ? `+${digits(m[5].replace(/[+*\s]/g, ''))}` : '';
      const text = `${hh}:${mm}${ampm ? ` ${ampm}` : ''}${plus}`;
      // trailing marks after a time are usually a superscript "+1" that could not be read: the day is uncertain
      const unreadMark = /['"`°^*]/.test(m[6]);
      const changed = hh !== m[1] || mm !== m[3] || m[2] !== ':' || (m[5] && m[5] !== plus) || unreadMark;
      return changed ? { ...w, text, corrected: t } : (text === t ? w : { ...w, text });
    }
  }
  // airport code with a digit read for a letter ("C0G", "8CN"): only when the result is a known airport
  const c = /^([A-Z0-9]{3})([,.]?)$/.exec(t);
  if (c && /\d/.test(c[1]) && (c[1].match(/[A-Z]/g)?.length ?? 0) >= 2) {
    const fixed = c[1].replace(/\d/g, (d) => LETTER[d] ?? d);
    if (/^[A-Z]{3}$/.test(fixed) && isKnownAirport(fixed)) return { ...w, text: fixed + c[2], corrected: t };
  }
  // flight number written as one word with a letter in the number part ("AF1O21")
  const f = /^([A-Z][A-Z0-9]|[0-9][A-Z])([0-9OoIl]{2,4})([,.]?)$/.exec(t);
  if (f && /[OoIl]/.test(f[2]) && /\d/.test(f[2])) return { ...w, text: f[1] + digits(f[2]) + f[3], corrected: t };
  return w;
}

/** Normalises every word, and the number part of a flight number written as two words ("AF" "1O21"). */
export function normalizeWords(words: OcrWord[]): OcrWord[] {
  const out = words.map(normalizeWord);
  // airline names that are also airport codes ("TAP Air Portugal" — TAP is Tapachula; "LOT Polish Airlines"): not codes
  for (let k = 0; k + 1 < out.length; k++) {
    const nx = out[k + 1];
    if (AIRLINE_WORDS.has(out[k].text.replace(/,$/, '')) && /^[A-Z][a-z]+/.test(nx.text) && nx.y0 < out[k].y1 && nx.y1 > out[k].y0)
      out[k] = { ...out[k], text: out[k].text.charAt(0) + out[k].text.slice(1).toLowerCase() };
  }
  for (let k = 1; k < out.length; k++) {
    const prev = out[k - 1].text, t = out[k].text;
    if (/^([A-Z][A-Z0-9]|[0-9][A-Z])$/.test(prev) && /^[0-9OoIl]{2,4}[,.]?$/.test(t) && /[OoIl]/.test(t) && (t.match(/\d/g)?.length ?? 0) >= 2)
      out[k] = { ...out[k], text: digits(t.replace(/[,.]$/, '')) + (t.match(/[,.]$/)?.[0] ?? ''), corrected: t };
    // designator read in mixed case after an airline name ("SWISS Lx 256"): upper-cased, to check
    const before = out[k - 2]?.text ?? '';
    if (/^[A-Z][a-z]$|^[a-z][A-Z]$/.test(prev) && /^\d{1,4}[,.]?$/.test(t) && /^[A-Za-z]{3,}$/.test(before) && out[k - 2].y0 < out[k - 1].y1 && out[k - 2].y1 > out[k - 1].y0)
      out[k - 1] = { ...out[k - 1], text: prev.toUpperCase(), corrected: prev };
  }
  return out;
}
