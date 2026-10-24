/**
 * GWIS `ecmwf.query` GetFeatureInfo answers recorded verbatim for V2-B1
 * (`INFO_FORMAT=text/html`, a 0.2° box around the point). Kept as a module so core tests
 * need no file system.
 */

/** Sofia (42.7, 23.3), TIME = the recording day. */
export const GFI_SOFIA =
  '<H2>Fire Danger</H2>\n<table id="main">\n    <tr><td>Fire Weather Index (FWI)</td><td>1.4407467</td></tr>\n    <tr><td>Initial Spread Index (ISI)</td><td>0.98114252</td></tr>\n    <tr><td>Build Up Index (BUI)</td><td>28.102715</td></tr>\n    <tr><td>Fine Fuel Moisture Code (FFMC)</td><td>74.816093</td></tr>\n    <tr><td>Duff Moisture Code (DMC)</td><td>15.060584</td></tr>\n    <tr><td>Drought Code (DC)</td><td>524.21722</td></tr>\n    <tr><td>Anomaly Index</td><td>-0.48647934</td></tr>\n    <tr><td>Ranking Index</td><td>13.190465</td></tr>\n</table>\n';

/** A point in the Black Sea: GWIS answers over water too. */
export const GFI_BLACK_SEA =
  '<H2>Fire Danger</H2>\n<table id="main">\n    <tr><td>Fire Weather Index (FWI)</td><td>0.43938288</td></tr>\n    <tr><td>Initial Spread Index (ISI)</td><td>0.88725281</td></tr>\n    <tr><td>Build Up Index (BUI)</td><td>6.8013101</td></tr>\n    <tr><td>Fine Fuel Moisture Code (FFMC)</td><td>64.942688</td></tr>\n    <tr><td>Duff Moisture Code (DMC)</td><td>3.5412037</td></tr>\n    <tr><td>Drought Code (DC)</td><td>214.20364</td></tr>\n    <tr><td>Anomaly Index</td><td>-0.40377828</td></tr>\n    <tr><td>Ranking Index</td><td>1.4185817</td></tr>\n</table>\n';

/** Any point, TIME past the D9 horizon: an empty 200. */
export const GFI_BEYOND_HORIZON = '';
