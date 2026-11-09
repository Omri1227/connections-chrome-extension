// Types of the screenshot input mode. A screenshot is read on this computer (OCR) into a DRAFT itinerary in which every
// field carries how sure the reading is; the traveller confirms or corrects the draft before anything is analysed.

/** One word found by OCR, with its box in the (preprocessed) image and the engine's confidence 0–100. */
export interface OcrWord { text: string; conf: number; x0: number; y0: number; x1: number; y1: number; corrected?: string }

export interface OcrResult {
  words: OcrWord[];
  /** Size of the image that was read (after scaling) and the scale applied to the pasted image. */
  width: number; height: number; scale: number; inputWidth: number; inputHeight: number;
  ms: { decode: number; preprocess: number; init: number; recognize: number; total: number };
}

/**
 * How a field was established:
 *  'read'     read clearly from the screenshot (and, for connection times, consistent with the connection time shown);
 *  'check'    read, but unclear, corrected from a likely misreading, or worked out (dates, year) — the traveller must confirm;
 *  'missing'  not in the screenshot;
 *  'typed'    entered or confirmed by the traveller.
 */
export type FieldState = 'read' | 'check' | 'missing' | 'typed';
export interface Field { value: string | null; state: FieldState; why?: string }

export const LEG_FIELDS = ['from', 'to', 'depDate', 'depTime', 'arrDate', 'arrTime', 'flightNumber', 'airline'] as const;
export type LegField = (typeof LEG_FIELDS)[number];

export interface DraftLeg {
  f: Record<LegField, Field>;
  altNumbers: string[];
  operatedBy: string | null;
}
export interface DraftJourney {
  label: string;
  legs: DraftLeg[];
  /** Per connection: true = the screenshot labels it a self-transfer; null = not shown (the traveller chooses). */
  selfTransferAt: (boolean | null)[];
  /** Per connection: how the ticket type was established. */
  ticketState: FieldState[];
}
export interface Draft {
  journeys: DraftJourney[];
  warnings: string[];
  /** Connection times confirmed by the "1h 35m connection" text in the screenshot, per journey and connection. */
  crossChecked: string[];
}
