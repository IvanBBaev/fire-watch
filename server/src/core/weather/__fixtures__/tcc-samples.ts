/**
 * Real ECMWF `tcc` (total cloud cover) GRIB2 messages for the F17 cloud-per-pass tests,
 * base64-encoded so the pure core's tests need no file I/O.
 *
 * Provenance: the ECMWF Open Data IFS 0.25° run of 2026-09-30 00z, steps 6 and 12,
 * Range-requested with the offsets from each step's `.index`. The full messages
 * (565 247 / 571 748 bytes) decode with our `decodeGrib2` byte-for-byte equal to ecCodes
 * 2.43 on all 1 038 240 points. They are too large to commit, so each was cropped to the
 * polling bbox (20–31°E, 39–46°N; 45 × 29 points) by cloning the real message in ecCodes
 * and re-encoding with the real message's own packing — `grid_ccsds` (template 5.42),
 * 8 bits, block 32, RSI 128, flags 14, binary scale −7. Sections 1, 2 and 4 are the real
 * message's: parameter 0/6/192 (ECMWF-local total cloud cover, a 0–1 *fraction*),
 * surface type 1, and a missing surface value. The cropped values equal the full field's
 * values at the same points exactly (checked in ecCodes).
 *
 * `TCC_EXPECTED` holds ecCodes' decoded values at a few 0.5° pass-cell centres — IFS grid
 * points, so no interpolation is involved in reading them.
 */

/** tcc, 2026-09-30 00z, step 6 h — 1158 bytes. */
export const REAL_TCC_STEP6 =
  'R1JJQv//AAIAAAAAAAAEhgAAABUBAGIAACABAQfqCR4AAAAAAQAAABECAAEAAQAJBAEwMDAxAAAASAMAAAAFGQAA' +
  'AAAG////////////////////AAAALQAAAB0AAAAA/////wK954ABMS0AMAJTF8AB2QXAAAPQkAAD0JAAAAAAIgQA' +
  'AAAABsAC/6EAAAABAAAABgH//////wj//////wAAABkFAAAFGQAqAAAAAIAHAAAIAA4gAIAAAAAGBv8AAAPDB2AI' +
  'gIQB7f/6Z5/yCgAAAFfov/6AAYgAAD6DAK+AAHA8L+EBAAb///EDUAARaGcBFAAH/9f+1SHQAAdFAAJ/9ERkCgkA' +
  'gEBP8AAAAEutxzNTvhgACf/9If+yCACAAAAAAABDXQBp17RAIAIAoV///xCKg+c8gAAAAIEgAMJ2Wf2QHIBX//ew' +
  'AAWjQvE5+7N6fwARAACL+s2v3ICgQ7TVBNRu2imbABxpNjG5OFc6hIL/9WFhHfjB81BTAAAARc2jR7EIsAAb6DEE' +
  'QgByn/7tr5HnHdZYqKmCSIAJmfQX5RKW/9iCCJAFv2bdV13wAALEW04WrXsQABKf1kBHEF0/IcogoIiD1M1rzgAF' +
  'EJ0EUIf//sjp6mBU2SatyEBFGMbZGdzMHWCfp6CYl7VBKIP4AHDYG919k71qstc5IEl3+o0MgwILjhGWjPyAApmS' +
  'MdKTXI9FiJ1W/+rGy7VgjmdERoTKZEQAJ8usc5nJsiORhUaeqfu6pHowgDcAANUVBHttCqP24gtIQxDT5Qxd3H3Z' +
  'xL2ypvbrAK7Tv4K5//rwAKJ03phEgDYGIkAgX461WiyE6NoIGiBPqch///cHF8ID8bMnIi8sogEyARC1ABIU5ZCE' +
  'gb+2VT1Qen7KhrUcIGrGRdEVAEv//QAYcxg0ZWQAQgAAAABz8KVkAj8TWwiAokv8f+AhAoZDmw0hQHYAAADprJzw' +
  'onkfwQgS/6/iGdPL7EGrqhC4hMFZ5ESoX/wAJBBLRNTjAriAv4pVi2gcz3uY6uVZJEhb/3/+ABRYzt3YqZVbAAAB' +
  'Vk4QHh+lJk5Y8IYDF+/Skfb6oBUOTS8DRI1kJC+AALox1cJO43ABITNwMdJIEoaGQnEFDUVr//8AA2M1SIjeEADM' +
  'EgAAAab1IPuVQly+UhIvKV/T/wAlBYLWQJjBgpT3RjKFYALp0x9VLcb3z/paCpo+CSflRcTVSFqBDOozWAAALr+g' +
  'AShSoSHwiCZADQAAACVRvHfs+ZCBZfKNbsr/v+AAdpSoWqcAAAHGyQSAAALw6JkyqSt6QhSTf/sEJqQdYtycJ1oI' +
  'CXhEAAAF9ACkIxdA/oj+AHN6Vq/pGaAIAAADdGXCg3ueV7AAIyAiCwTOANy9kCVhEAHgTe6d56AxAu5U/8hA7+gA' +
  'IO+Ub1RBqCyAM/3mh8wOx7jRao/xo9/g4+Le1XDRF0AHMM0jo0YkMBahJNTIhgh8AAcKK5A39zBQaSZscxeIuvde' +
  'YEBfl4zw1CPKLF//AAAw2lJIoDY3WbfM4Ac8CAAAAAA3Nzc3';

/** tcc, 2026-09-30 00z, step 12 h — 1204 bytes. */
export const REAL_TCC_STEP12 =
  'R1JJQv//AAIAAAAAAAAEtAAAABUBAGIAACABAQfqCR4AAAAAAQAAABECAAEAAQAJBAEwMDAxAAAASAMAAAAFGQAA' +
  'AAAG////////////////////AAAALQAAAB0AAAAA/////wK954ABMS0AMAJTF8AB2QXAAAPQkAAD0JAAAAAAIgQA' +
  'AAAABsAC/6EAAAABAAAADAH//////wj//////wAAABkFAAAFGQAqAAAAAIAHAAAIAA4gAIAAAAAGBv8AAAPxBxAM' +
  'P8z3+QCEBAAAAj/XP+AAUaArAiAAE///kDAA+iBgEApMgAAAACdSkCoXmiGm04h//+j8U8HaSKB/gBZ7gAAAAADV' +
  'ET6TQUhkWv+a8fAQolvNX/vr0gkDRtl7mAD/6CcARUEAz/8gAAACYEGkallhkEz///8wAQgBkCAAAAAASAAAALIi' +
  'TDEEoWAgf///8NSR9gEAAAAAAAAAX+ggqyZpJ/4CIIW0nw/+6qZqkmIAAAABP//5CAQBEIMTSAAAAAAQCRcgUfVQ' +
  'ixCAEAEA////zcUBEAAAAAlCRgTAHrIgQgL//n+6PMazWpYJABSJIn/0mSIgPpRAJCACAAAAAefxgzaOmRR7D7Jk' +
  'v/xAIECAhEkgsqIekAAApDNE0hUDIbxMFu0E4Qqd/4zjbFkHZR1YKx98s3/xioXRF1axTayvGSiE2QoiNB6j8cWm' +
  '4bUh6tcvRbsit9cSoRxmmkCeLsz3AjG+hyk4Cgbdp9V/9SSThUjnkRu7icSLtAPunELD+Kbe5Ll34hFIGF88iwny' +
  '9CAvGC2IAKVd0gvMiBao/QQQXvr0pr8lZ0irKvTpvE1HX+4BcnGABbkI0mfdXvzqkzxNxPypqV/pn+l/NJ9Yg0tW' +
  'p1WOjMfpN3HK9V/M5VYDmd1lllDVg3rGpGGE5MRA3SZtjqOF/XBEQIQtqGD9jmEFjCVOb53Pp58Sx85EKiCRRaRM' +
  'f/zBESPD6p7GO8dqBQIAINZxQxqhBPbkPBDLSFQnnEIRnBvs3bU/K9TSnscyAu/VkaM9tfN4piBsq07G23fVfe4Q' +
  'KFR8AVmZzt79/9iGk1+jgB3mYfgFrf+0inGYwVOrGL0OWtN6kdPddeidigMLcoyqC7TNCCgnd41WiUZEogpVYmrT' +
  'wcTcd/ENFN6x0uqnRYCz1avxSfZKkCcbCfSwlZ3HUJzPvOrHroiV8nxatLL/6CMhkQEJueLXF/MgkQAbg0jmM/sC' +
  'vkTV01t9zL0AGRpr8MIM+gVVvih4fkNzvLD7J3RrTEUYmcYZb/dZZAa56Rh6P/HzWofZUz841QdXN+uSxliflFPY' +
  'DmFGK6qB6cDJBbIZaGv6a3PT7Ii6r79q/14/xP2wpjKbJXSdqjonLiCgdNL6ytNJKlO1Zzt+wZ0Niugtk4TKPfbD' +
  'eFFtEgbMh9/qU1Sy1VygsYAAboPqogklv0fkInzXU0PZI3hI/+bdXy4hS5pZDa2UDjf6BF5ChUfzePha2jhTn0LF' +
  '/6Y28Zyc49CqgHELiABXZxUGmRVR0JGUeCVqjHOyZ+5pLck9wVaFKOHjxyFAiLokwYAALhStJYKkxggwf4CvuWuv' +
  'HHo70Owby+gAAAAANzc3Nw==';

/** ecCodes-decoded fractions at `lat,lon` pass-cell centres, per step. */
export const TCC_EXPECTED = {
  step6: {
    '42.75,23.25': 0.46875,
    '42.25,25.75': 0.828125,
    '39.25,20.25': 0.5,
    '45.75,30.75': 0.0,
    '41.75,27.25': 0.8671875,
    sum: 611.9453125,
    min: 0.0,
    max: 1.0,
  },
  step12: {
    '42.75,23.25': 0.1015625,
    '42.25,25.75': 0.6484375,
    '39.25,20.25': 0.8671875,
    '45.75,30.75': 0.0,
    '41.75,27.25': 0.53125,
    sum: 551.9375,
    min: 0.0,
    max: 1.0,
  },
} as const;
