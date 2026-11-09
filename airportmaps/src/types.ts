// Simplified airport mapping model (multi-airport, Chrome-extension pilot level).
// One JSON file per airport: airportmaps/data/<iata>/airport.json, plus evidence.json (observations from sources).
// Scope: terminals, concourses and satellites; gate numbers grouped by area with approximate placement; walking
// connectivity; inter-terminal transport (trains, people movers, buses); an area-to-area movement graph.
// Out of scope: turn-by-turn indoor routes, precise gate coordinates, detailed checkpoint procedures.
//
// Schematic coordinates: a plane of `schematic.width` × `schematic.height` units (default 1000 × 640), x to the right,
// y downwards. The drawing preserves the approximate geographic relationships (which building is north/east of which),
// rotated so that `schematic.northDeg` is where north points (0 = up). It is NOT a survey-accurate plan.

/** Evidence grade of one fact (see docs/AIRPORT_MAPPING_SIMPLE.md §3).
 *  verified: ≥ 2 independent source groups, at least one official or first-hand (video/photo), no contradiction.
 *  probable: one good source (official, or clear first-hand), or several from one group; no contradiction.
 *  inferred: deduced from geometry/maps/indirect statements; stated as an assumption.
 *  unknown:  not established; the item is kept only so the gap is visible. */
export type Confidence = 'verified' | 'probable' | 'inferred' | 'unknown';

export type SourceKind = 'official' | 'official-map' | 'official-pdf' | 'airline' | 'operator' | 'guide' | 'video' | 'photo' | 'osm' | 'forum' | 'wiki' | 'news' | 'other';

export interface Source {
  id: string;            // e.g. "src:fra-official-map"
  title: string;
  url: string;
  publisher: string;
  kind: SourceKind;
  /** Independence group: one publisher/channel = one group; mirror sites share a group. */
  group: string;
  accessed: string;      // ISO date the source was read
  published?: string;    // ISO date or year if known (videos: upload date)
  notes?: string;        // what it was used for, limitations, licence
}

/** Passenger side of a place. Restrictions between sides are expressed as controls on connections. */
export type Side = 'landside' | 'airside';
/** Border zone of an airside place. Schengen airports: 'schengen' / 'non-schengen'. Airports outside Schengen with a
 *  domestic/international split (e.g. IST): 'domestic' / 'international'. 'mixed' = gates switch / both; 'n/a' for landside.
 *  Crossing between the two zones of a pair needs a passport control (validator). */
export type Zone = 'schengen' | 'non-schengen' | 'domestic' | 'international' | 'mixed' | 'n/a';
/** Zone pairs separated by a border (passport) control. */
export const BORDER_PAIRS: [Zone, Zone][] = [['schengen', 'non-schengen'], ['domestic', 'international']];

export type AreaKind = 'terminal' | 'concourse' | 'pier' | 'satellite' | 'station' | 'landside-hall' | 'transfer-hub' | 'other';

export type Shape =
  | { type: 'rect'; x: number; y: number; w: number; h: number; rotate?: number; r?: number }
  | { type: 'poly'; points: [number, number][] };

/** Operational state of an area, stop, walk or line during a period (ISO dates, inclusive; open-ended when omitted).
 *  Items are 'active' unless a period covering the routing date says otherwise. Non-active items are never routed. */
export interface StatusPeriod {
  state: 'active' | 'suspended' | 'closed' | 'planned';
  from?: string;         // ISO date the state starts (inclusive)
  until?: string;        // ISO date the state ends (inclusive)
  note: string;          // what changes, e.g. "Sky Line closed for the T3 tie-in works"
  confidence: Confidence;
  sources: string[];
}

/** Several areas drawn on one footprint (e.g. FRA Concourse A level 2 Schengen and Concourse Z level 3 non-Schengen,
 *  same aircraft stands). The viewer draws the members offset from each other, lowest `order` at the bottom. */
export interface Stack {
  group: string;         // shared id of the footprint, e.g. "fra-a-z"
  order: number;         // 0 = lowest level
  label: string;         // level label shown on the map, e.g. "L2" / "L3"
}

/** A major area = a node of the movement graph and a selectable item on the map. */
export interface Area {
  id: string;            // e.g. "fra-t1-a" (lower-case, airport prefix)
  name: string;          // "Terminal 1 · Concourse A"
  short: string;         // "A" (map label, ≤ 6 chars preferred)
  kind: AreaKind;
  terminal?: string;     // terminal name/number the area belongs to, e.g. "T1"
  side: Side;
  zone: Zone;
  /** Shown as a row/column of the transfer matrix. */
  matrix: boolean;
  /** Label anchor (schematic units). */
  anchor: [number, number];
  shape?: Shape;         // building outline (approximate); omit for small nodes such as stations
  level?: string;        // e.g. "Level 2 departures" when it matters for movement
  /** Member of a stacked footprint (levels sharing a building outline). */
  stack?: Stack;
  /** 'segregated': passengers arriving at this area's gates are kept apart from departing passengers (separate arrivals
   *  level/corridor), so a route starting here from an arriving flight must begin with a `flow: 'arrivals'` walk.
   *  Needs at least one outgoing arrivals-flow walk (validator). */
  arrivals?: 'segregated';
  /** Dated border zone: overrides `zone` inside the period (e.g. MUC T1 modules A/B non-Schengen until 2026-04-20). */
  zones?: { zone: Zone; validFrom?: string; validUntil?: string }[];
  /** Gate-to-gate walk between two (unknown) gates of this area, for a connection inside the area: typical = expected
   *  distance, max = conservative (≈ 90th percentile). Absent → the router derives it from the gate groups' placement and
   *  the model's own walk speeds (basis 'derived') or uses an assumed short walk. Never 0. */
  intraWalk?: Minutes & { sources?: string[] };
  /** A real landside check-in / bag-drop hall: `serves` = airside area ids whose departures check in here (self-transfer
   *  deadline point). Only areas with this field are used as check-in halls when any area of the model has it. */
  checkIn?: { serves: string[]; sources?: string[]; note?: string; facilities?: CheckInFacility[] };
  /** Controls passed on EVERY entry into this area (walks and platform egress ending here), so that no route can walk
   *  around them (R-36). `exceptFrom`: area / stop ids whose entry does not pass the control. */
  entryControls?: (Control & { exceptFrom?: string[] })[];
  /** Controls an ARRIVING passenger passes on a connection inside this area (CR-B1, e.g. CDG 2E transfer security),
   *  applied with the intra-area walk. Conditional controls follow `when`. */
  intraControls?: Control[];
  status?: StatusPeriod[];
  description?: string;
  confidence: Confidence;
  sources: string[];     // Source ids
  notes?: string;
}

/** Gate numbers of one area, grouped as they are signed/numbered. Gate lists must come from sources. */
export interface GateGroup {
  id: string;            // "fra-gates-a1-a26"
  area: string;          // Area id
  label: string;         // "A1–A26"
  /** Explicit gate identifiers as signed ("A1", "A2", …, "Z50"). Only gates attested by a source. */
  gates: string[];
  zone?: Zone;           // overrides the area's zone when the gate group is in a different border zone
  /** Gate-level zone overrides inside the group (e.g. swing gates). */
  zoneGates?: { gates: string[]; zone: Zone }[];
  /** Walk from this group's gates to the area's routing point (R-32; not yet used by the router). */
  offset?: Minutes;
  /** Approximate placement: a polyline along which the gates are spread, in order (schematic units). */
  path: [number, number][];
  /** Remote/bus gates (boarding by apron bus). */
  bus?: boolean;
  status?: StatusPeriod[];
  confidence: Confidence;
  sources: string[];
  notes?: string;
}

export type ControlKind = 'security' | 'passport' | 'transfer-security' | 'boarding-pass' | 'customs' | 'special-screening';

/** A control that a connection passes through (only those that affect whether / how a connection is usable). */
export interface Control {
  kind: ControlKind;
  /** Typical processing allowance in minutes (queue + process), with min/max, and its basis. */
  minutes: Minutes;
  /** When the control applies, e.g. "only when entering the Schengen zone". */
  note?: string;
  /** Conditional control (R-05): 'origin-not-one-stop' = only when the inbound flight's origin is NOT covered by the
   *  model's `oneStopSecurity`. Origin unknown → the control applies and the route carries a material issue. */
  when?: 'origin-not-one-stop';
  /** Published opening hours of this checkpoint (local time). A passenger who must pass it cannot take the edge when it
   *  is closed at the clock time it is reached (timed routes); a passenger exempt from a conditional control is not
   *  affected. `hoursNote` keeps qualifiers such as "until end of operations" (no closing time is invented). */
  hours?: TimeWindow[];
  hoursNote?: string;
}

/** A check-in / bag-drop facility of one airline (or airline group) in a hall, with its published opening hours.
 *  Facilities are airline-specific: an airline without a listed facility keeps the hall's unknown hours. `kind`
 *  separates staffed desks from self bag drop (usable only with a boarding pass from online check-in). */
export interface CheckInFacility {
  id: string;
  airlines: string[];
  kind: 'desk' | 'self-bag-drop';
  name: string;
  hours: TimeWindow[];
  /** Qualifiers kept as published ("at the earliest two hours before the first departure"); never turned into times. */
  hoursNote?: string;
  eligibility?: string;
  sources: string[];
}

/** Departures from these origins count as already screened to the EU/CH standard (one-stop security). */
export interface OneStopSecurity { countries: string[]; airports?: string[]; excludedAirports?: string[]; asOf: string; sources: string[]; note?: string }

/** Extra screening for some departures (destination / airline), R-19. */
export interface SpecialScreening {
  id: string;
  appliesTo: { destinationCountries?: string[]; destinationAirports?: string[]; airlines?: string[] };
  /** Departure areas used by these flights (restricts the departure candidates unless certainty is 'unknown'). */
  areas?: string[];
  minutes?: Minutes;
  /** A published presence deadline before departure (CR-B4): not a duration; it replaces the gate-close deadline when later. */
  deadline?: { minutesBeforeDeparture: number; basis: Minutes['basis']; text: string };
  /** Level of the route issue it creates (default material). */
  issueLevel?: 'material' | 'secondary';
  certainty: 'verified' | 'probable' | 'unknown';
  text: string;
  sources: string[];
}

/** A duration range and where it comes from:
 *  published = stated by the operator/airport (timetable, signage, official page);
 *  measured  = timed from first-hand evidence (uncut video segment, timestamps; method in the notes/evidence);
 *  observed  = seen but not timed precisely (e.g. a video with cuts, a forum report of "about 5 minutes");
 *  derived   = computed from other facts (distance ÷ walking speed, headway ÷ 2);
 *  assumed   = planning value without specific evidence. */
export interface Minutes { min: number; typical: number; max: number; basis: 'published' | 'measured' | 'derived' | 'observed' | 'assumed'; note?: string }

/** A daily time window, local time "HH:MM". `until` < `from` wraps past midnight ("22:00"–"05:00").
 *  "00:00"–"24:00" = all day. */
export interface TimeWindow { from: string; until: string }
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Who may use a connection (walk or line). */
export type Access =
  | 'public'                // anyone (landside)
  | 'airside'               // any passenger already airside (in the zone(s) it links)
  | 'transfer'              // connecting passengers only (e.g. airside inter-terminal bus)
  | 'restricted';           // staff only or not passengers: never routed; kept to record that it is NOT usable

/** A walking connection between two areas/stations. */
export interface Walk {
  id: string;            // "w:fra-a-b"
  from: string;          // Area id
  to: string;            // Area id
  bidirectional: boolean;
  access: Access;
  /** Walking minutes between the two areas' typical points (area centre to area centre), excluding controls. */
  minutes: Minutes;
  distanceM?: number;
  /** Controls passed in the from → to direction (bidirectional walks: also the reverse unless `reverseControls` is set). */
  controls?: Control[];
  reverseControls?: Control[];
  /** practical = normal way to go; long = walkable but transport is usually better; avoid = possible, not recommended. */
  practical: 'practical' | 'long' | 'avoid';
  /** 'arrivals' = part of the arriving-passenger flow (e.g. pier → arrivals corridor → reclaim / transfer desk): usable only
   *  at the start of a route whose origin is an arriving flight, before any other movement. Must be one-way
   *  (bidirectional: false). Omit for ordinary walks. */
  flow?: 'arrivals';
  status?: StatusPeriod[];
  /** Daily opening hours when the corridor/passage is not always open (e.g. closed at night). Omit = always open.
   *  Only applied when a route is asked for a time of day (`Profile.time`). */
  hours?: TimeWindow[];
  /** Moving walkways, level changes, landmarks along the way (no turn-by-turn). */
  via?: string;
  confidence: Confidence;
  sources: string[];
  notes?: string;
}

export type LineMode = 'train' | 'people-mover' | 'bus' | 'shuttle-bus' | 'rail' | 'other';

/** A stop/station of a transport line. Each stop belongs to an area (where you board, as a passenger reaches it). */
export interface Stop {
  id: string;            // "s:fra-skyline-t1"
  name: string;          // as signed: "Terminal 1 (Concourse A/B)"
  area: string;          // Area id the stop is reached from (boarding / alighting place)
  side: Side;
  anchor: [number, number];
  /** Walking minutes from the area's typical point to the platform / bus stand (excluding controls). */
  accessMinutes: Minutes;
  /** Controls passed going from the area to the platform (boarding). */
  accessControls?: Control[];
  /** Controls passed going from the platform into the area (alighting). Defaults to none. */
  egressControls?: Control[];
  where?: string;       // "Level 3, departures hall B, follow 'SkyLine'"
  status?: StatusPeriod[];
  /** Daily opening hours of the station access when it closes independently of the line. Omit = follows the line. */
  hours?: TimeWindow[];
  confidence: Confidence;
  sources: string[];
  notes?: string;
}

/** One service pattern of a line (e.g. daytime / evening / night, or weekdays / weekends, or a works period).
 *  Selection for a routing date + time: the first entry whose `validFrom/validUntil`, `days` and `windows` all match.
 *  A temporary timetable (an entry with both `validFrom` and `validUntil`, e.g. a works period) valid on the date replaces
 *  all other entries for that whole day: outside its windows the line is closed, without falling back to the normal pattern.
 *  Without `Profile.time`, the first entry valid on the date (ignoring windows) is used as the "typical daytime" service.
 *  With a time and no matching entry, the line is NOT running then and is not routed. */
export interface LineService {
  /** Operating hours as text, local time, as published ("05:00–23:30"); "00:00–24:00" for 24 h. Human readable. */
  hours: string;
  /** Machine-readable windows for `hours`. Omit when the hours are not published (then the entry matches any time and
   *  routes carry a "hours not published" warning when a time is asked). */
  windows?: TimeWindow[];
  /** Weekdays this pattern applies to (omit = every day). */
  days?: Weekday[];
  /** Date range this pattern applies to (ISO, inclusive), e.g. a reduced timetable during works. */
  validFrom?: string;
  validUntil?: string;
  /** Headway range in minutes and the typical wait (half the headway unless observed otherwise). */
  headwayMin: { min: number; max: number };
  /** Basis of the headway figures (default: the waitMin basis). */
  headwayBasis?: Minutes['basis'];
  waitMin: Minutes;
  /** Sources of this service pattern specifically (hours/headway); the line's sources otherwise. */
  sources?: string[];
  notes?: string;
}

export interface Line {
  id: string;            // "l:fra-skyline"
  name: string;          // "SkyLine"
  mode: LineMode;
  operator?: string;
  colour: string;        // map colour (hex)
  access: Access;
  side: Side;
  /** Ordered stop ids along the route. */
  stops: string[];
  /** 'both' = runs both ways; 'loop' = one-way loop in the listed order (last → first closes the loop); 'one-way' = listed order only. */
  direction: 'both' | 'loop' | 'one-way';
  /** Ride minutes between consecutive stops: rideMin[i] = stops[i] → stops[i+1] (loop: one more element, last → first).
   *  Door-close to door-open, including dwell at intermediate stops passed. This is the typical value. */
  rideMin: number[];
  /** Optional ride ranges with their basis, parallel to rideMin (ride[i].typical must equal rideMin[i]).
   *  Without it, rides are reported as min = typical = max with basis `rideBasis` (default 'assumed'). */
  ride?: Minutes[];
  /** Basis of rideMin when `ride` is omitted. */
  rideBasis?: Minutes['basis'];
  /** Set when the line is drawn on the map but must NOT be routed (operation or passenger eligibility unverified,
   *  e.g. a crew/staff shuttle or a service seen once). The text says why. */
  notRouted?: string;
  /** Line id this service replaces during its active periods (replacement bus for a suspended people mover). */
  replaces?: string;
  service: LineService[];   // usually one entry; several if day/night or weekday differ
  /** Who may ride, and restrictions (e.g. "transfer passengers with boarding pass, non-Schengen ↔ non-Schengen"). */
  eligibility: string;
  /** Map path (schematic units) through the stops' anchors; omit to draw straight segments. */
  path?: [number, number][];
  /** Suspensions / closures / planned openings with dates; the line is 'active' outside them. */
  status?: StatusPeriod[];
  confidence: Confidence;
  sources: string[];
  notes?: string;
}

export interface OpenQuestion {
  id: string;
  question: string;
  impact: string;          // what it changes for routing
  howToResolve: string;    // owner capture, field check, source to request
}

export interface MapLabel { text: string; at: [number, number]; kind: 'road' | 'runway' | 'water' | 'district' | 'note'; rotate?: number }

export interface AirportModel {
  iata: string;
  icao?: string;
  name: string;
  city: string;
  /** ISO date of the research snapshot. */
  asOf: string;
  schematic: {
    width: number;         // default 1000
    height: number;        // default 640
    northDeg: number;      // direction of north on the drawing, degrees clockwise from up
    /** Background features (runways, roads, aprons) as simple shapes for orientation only. */
    background?: { shape: Shape; kind: 'runway' | 'apron' | 'road' | 'rail' | 'water' | 'parking' | 'other'; label?: string }[];
    labels?: MapLabel[];
  };
  areas: Area[];
  gateGroups: GateGroup[];
  stops: Stop[];
  lines: Line[];
  walks: Walk[];
  /** Airport-wide facts that affect routing (zone rules, minimum connection times …), each with sources. */
  rules: { id: string; text: string; confidence: Confidence; sources: string[] }[];
  openQuestions: OpenQuestion[];
  sources: Source[];
  /** IANA time zone of the airport (local times of the model's hours and of the flights). */
  tz?: string;
  /** Origins whose departures are already screened (conditional transfer security, R-05 / R-42). */
  oneStopSecurity?: OneStopSecurity;
  /** Extra screening by destination / airline (R-19). */
  specialScreening?: SpecialScreening[];
  /** Exact terminal strings as the flight-data feed sends them → area ids (R-17, R-23); takes precedence over name matching. */
  feedTerminals?: { arrival?: Record<string, string[]>; departure?: Record<string, string[]> };
  /** Published airline → terminal allocation (e.g. Heathrow's official terminal finder), used ONLY when a flight has no
   *  history and no value published for the day. Terminal strings use the `feedTerminals` keys. `byDestination` overrides
   *  `defaults` for the listed destination airports (other end of the flight, either direction). Shown as "estimated"
   *  (typical for the airline), never with a percentage. Not applied to legs operated by another carrier (codeshares). */
  airlineTerminals?: { defaults: Record<string, string>; byDestination?: { airline: string; terminal: string; airports: string[] }[]; asOf: string; confidence: Confidence; sources: string[]; note?: string };
  /** Asymmetric borders: zone changes that pass NO passport control in this direction (e.g. the UK has no exit control,
   *  so domestic → international is open while international → domestic passes UK immigration). The validator does not
   *  require a passport control on walks in these directions; the reverse direction still needs one. */
  openBorders?: { from: Zone; to: Zone; note: string; sources: string[] }[];
}

/** One observation read from a source (especially videos/images): what is visible, where, when. */
export interface EvidenceItem {
  id: string;              // "ev:fra-yt-abc123-0412"
  source: string;          // Source id
  /** Timestamp in a video (s), page/figure of a PDF, photo caption … */
  locator?: string;
  observed: string;        // fact as seen/read (sign text, gate numbers, sequence of spaces, timings)
  method: 'video-frames' | 'video-description' | 'photo' | 'map-reading' | 'text' | 'osm' | 'timetable' | 'other';
  /** Model ids this observation supports or contradicts. */
  supports?: string[];
  contradicts?: string[];
  date?: string;           // travel/recording date if known
}

export interface EvidenceFile {
  iata: string;
  items: EvidenceItem[];
}
