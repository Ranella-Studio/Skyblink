// Ported from Ranella-Studio/Nasa-Challenge (first version): web/src/data/survey.js (and surveyNumber from web/src/lab/visits.js)
// SPHEREx survey calendar. Science operations began 2025-05-01 and each
// all-sky pass takes about six months.
// (Adapted: the i18n labels and CSS colour helper of the first version were dropped.)

export const SURVEY_START_MJD = 60796; // 2025-05-01
export const SURVEY_PERIOD = 182.6; // days per all-sky pass

/** Survey number of a date: 0 = commissioning, 1 = first six-month pass, ... */
export const surveyNumber = (mjd) => (mjd < SURVEY_START_MJD ? 0 : 1 + Math.floor((mjd - SURVEY_START_MJD) / SURVEY_PERIOD));
