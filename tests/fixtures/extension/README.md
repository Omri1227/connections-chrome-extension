# Skyscanner itinerary fixtures

The visible text (`innerText`) of one Skyscanner itinerary, one file per layout. These are **representative fixtures written for the parser**, modelled on the public layout of Skyscanner's results cards and itinerary details. They are not copies of live pages: live pages were not fetched (Skyscanner is protected against automated access, and the extension never fetches it). Real captures are made by the owner on their own browsing (see `extension/README.md`, "Capturing a fixture") and added here as `real-*.txt`, with personal details removed.

| File | Layout |
|---|---|
| `card-one-stop.txt` | results card, one way, 1 stop, no flight numbers |
| `card-return.txt` | results card, return: outbound 1 stop, return direct |
| `card-two-stops.txt` | results card, 2 stops |
| `details-one-stop.txt` | expanded details: 1 connection at CDG, flight numbers, dates, operated-by |
| `details-overnight-self-transfer.txt` | details: 2 connections (FRA, IST), +1 day, self transfer |
| `details-direct.txt` | details: direct flight |
| `details-us-format.txt` | en-US: "Nov 4, 2026", 12-hour times |
| `details-unsupported.txt` | connection at ATH (no map) |
| `details-return.txt` | outbound + return headings, connections at MUC and ZRH |
| `details-airport-change.txt` | details: change of airport IST → SAW, self transfer (must be "not assessed") |
| `details-to-tlv.txt` | details: CDG → MUC → TLV, ticket type not shown (Hall F, special screening) |
| `details-lhr-t3-t5.txt` | details: Virgin VS 4 JFK → LHR T3, BA 432 → AMS from T5 (ticket type not shown) |
| `details-lhr-elal.txt` | details: Lufthansa LH 900 FRA → LHR T2, El Al LY 316 → TLV from T4 |
| `details-lhr-self-transfer.txt` | details: KL 1001 AMS → LHR T4, self transfer, BA 404 → TLV from T5 |
| `noise.txt` | text with no itinerary (layout change / wrong element) |
