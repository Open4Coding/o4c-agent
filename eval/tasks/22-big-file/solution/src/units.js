// Unit conversions. Every function rounds to 4 decimal places.

function round(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Converts mm to cm.
 * @param {number} value - an amount in mm
 * @returns {number} the same amount in cm
 */
export function mmToCm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mmToCm: value must be a number');
  }
  return round(value * 0.1);
}

/**
 * Converts cm to mm.
 * @param {number} value - an amount in cm
 * @returns {number} the same amount in mm
 */
export function cmToMm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('cmToMm: value must be a number');
  }
  return round(value * 10);
}

/**
 * Converts cm to inches.
 * @param {number} value - an amount in cm
 * @returns {number} the same amount in inches
 */
export function cmToInches(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('cmToInches: value must be a number');
  }
  return round(value * 0.393701);
}

/**
 * Converts inches to cm.
 * @param {number} value - an amount in inches
 * @returns {number} the same amount in cm
 */
export function inchesToCm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('inchesToCm: value must be a number');
  }
  return round(value * 2.54);
}

/**
 * Converts m to feet.
 * @param {number} value - an amount in m
 * @returns {number} the same amount in feet
 */
export function mToFeet(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mToFeet: value must be a number');
  }
  return round(value * 3.28084);
}

/**
 * Converts feet to m.
 * @param {number} value - an amount in feet
 * @returns {number} the same amount in m
 */
export function feetToM(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('feetToM: value must be a number');
  }
  return round(value * 0.3048);
}

/**
 * Converts km to miles.
 * @param {number} value - an amount in km
 * @returns {number} the same amount in miles
 */
export function kmToMiles(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kmToMiles: value must be a number');
  }
  return round(value * 0.621371);
}

/**
 * Converts miles to km.
 * @param {number} value - an amount in miles
 * @returns {number} the same amount in km
 */
export function milesToKm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('milesToKm: value must be a number');
  }
  return round(value * 1.609344);
}

/**
 * Converts m to yards.
 * @param {number} value - an amount in m
 * @returns {number} the same amount in yards
 */
export function mToYards(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mToYards: value must be a number');
  }
  return round(value * 1.09361);
}

/**
 * Converts yards to m.
 * @param {number} value - an amount in yards
 * @returns {number} the same amount in m
 */
export function yardsToM(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('yardsToM: value must be a number');
  }
  return round(value * 0.9144);
}

/**
 * Converts grams to ounces.
 * @param {number} value - an amount in grams
 * @returns {number} the same amount in ounces
 */
export function gramsToOunces(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('gramsToOunces: value must be a number');
  }
  return round(value * 0.035274);
}

/**
 * Converts ounces to grams.
 * @param {number} value - an amount in ounces
 * @returns {number} the same amount in grams
 */
export function ouncesToGrams(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('ouncesToGrams: value must be a number');
  }
  return round(value * 28.3495);
}

/**
 * Converts kg to pounds.
 * @param {number} value - an amount in kg
 * @returns {number} the same amount in pounds
 */
export function kgToPounds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kgToPounds: value must be a number');
  }
  return round(value * 2.20462);
}

/**
 * Converts pounds to kg.
 * @param {number} value - an amount in pounds
 * @returns {number} the same amount in kg
 */
export function poundsToKg(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('poundsToKg: value must be a number');
  }
  return round(value * 0.453592);
}

/**
 * Converts stones to kg.
 * @param {number} value - an amount in stones
 * @returns {number} the same amount in kg
 */
export function stonesToKg(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('stonesToKg: value must be a number');
  }
  return round(value * 6.35029);
}

/**
 * Converts kg to stones.
 * @param {number} value - an amount in kg
 * @returns {number} the same amount in stones
 */
export function kgToStones(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kgToStones: value must be a number');
  }
  return round(value * 0.157473);
}

/**
 * Converts tonnes to pounds.
 * @param {number} value - an amount in tonnes
 * @returns {number} the same amount in pounds
 */
export function tonnesToPounds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('tonnesToPounds: value must be a number');
  }
  return round(value * 2204.62);
}

/**
 * Converts pounds to tonnes.
 * @param {number} value - an amount in pounds
 * @returns {number} the same amount in tonnes
 */
export function poundsToTonnes(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('poundsToTonnes: value must be a number');
  }
  return round(value * 0.000453592);
}

/**
 * Converts litres to gallons.
 * @param {number} value - an amount in litres
 * @returns {number} the same amount in gallons
 */
export function litresToGallons(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('litresToGallons: value must be a number');
  }
  return round(value * 0.264172);
}

/**
 * Converts gallons to litres.
 * @param {number} value - an amount in gallons
 * @returns {number} the same amount in litres
 */
export function gallonsToLitres(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('gallonsToLitres: value must be a number');
  }
  return round(value * 3.78541);
}

/**
 * Converts ml to teaspoons.
 * @param {number} value - an amount in ml
 * @returns {number} the same amount in teaspoons
 */
export function mlToTeaspoons(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mlToTeaspoons: value must be a number');
  }
  return round(value * 0.202884);
}

/**
 * Converts teaspoons to ml.
 * @param {number} value - an amount in teaspoons
 * @returns {number} the same amount in ml
 */
export function teaspoonsToMl(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('teaspoonsToMl: value must be a number');
  }
  return round(value * 4.92892);
}

/**
 * Converts ml to tablespoons.
 * @param {number} value - an amount in ml
 * @returns {number} the same amount in tablespoons
 */
export function mlToTablespoons(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mlToTablespoons: value must be a number');
  }
  return round(value * 0.067628);
}

/**
 * Converts tablespoons to ml.
 * @param {number} value - an amount in tablespoons
 * @returns {number} the same amount in ml
 */
export function tablespoonsToMl(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('tablespoonsToMl: value must be a number');
  }
  return round(value * 14.7868);
}

/**
 * Converts cups to ml.
 * @param {number} value - an amount in cups
 * @returns {number} the same amount in ml
 */
export function cupsToMl(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('cupsToMl: value must be a number');
  }
  return round(value * 236.588);
}

/**
 * Converts ml to cups.
 * @param {number} value - an amount in ml
 * @returns {number} the same amount in cups
 */
export function mlToCups(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mlToCups: value must be a number');
  }
  return round(value * 0.00422675);
}

/**
 * Converts pints to litres.
 * @param {number} value - an amount in pints
 * @returns {number} the same amount in litres
 */
export function pintsToLitres(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('pintsToLitres: value must be a number');
  }
  return round(value * 0.473176);
}

/**
 * Converts litres to pints.
 * @param {number} value - an amount in litres
 * @returns {number} the same amount in pints
 */
export function litresToPints(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('litresToPints: value must be a number');
  }
  return round(value * 2.11338);
}

/**
 * Converts quarts to litres.
 * @param {number} value - an amount in quarts
 * @returns {number} the same amount in litres
 */
export function quartsToLitres(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('quartsToLitres: value must be a number');
  }
  return round(value * 0.946353);
}

/**
 * Converts litres to quarts.
 * @param {number} value - an amount in litres
 * @returns {number} the same amount in quarts
 */
export function litresToQuarts(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('litresToQuarts: value must be a number');
  }
  return round(value * 1.05669);
}

/**
 * Converts acres to hectares.
 * @param {number} value - an amount in acres
 * @returns {number} the same amount in hectares
 */
export function acresToHectares(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('acresToHectares: value must be a number');
  }
  return round(value * 0.404686);
}

/**
 * Converts hectares to acres.
 * @param {number} value - an amount in hectares
 * @returns {number} the same amount in acres
 */
export function hectaresToAcres(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('hectaresToAcres: value must be a number');
  }
  return round(value * 2.47105);
}

/**
 * Converts sqm to sqft.
 * @param {number} value - an amount in sqm
 * @returns {number} the same amount in sqft
 */
export function sqmToSqft(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('sqmToSqft: value must be a number');
  }
  return round(value * 10.7639);
}

/**
 * Converts sqft to sqm.
 * @param {number} value - an amount in sqft
 * @returns {number} the same amount in sqm
 */
export function sqftToSqm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('sqftToSqm: value must be a number');
  }
  return round(value * 0.092903);
}

/**
 * Converts kph to mph.
 * @param {number} value - an amount in kph
 * @returns {number} the same amount in mph
 */
export function kphToMph(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kphToMph: value must be a number');
  }
  return round(value * 0.621371);
}

/**
 * Converts mph to kph.
 * @param {number} value - an amount in mph
 * @returns {number} the same amount in kph
 */
export function mphToKph(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mphToKph: value must be a number');
  }
  return round(value * 1.609344);
}

/**
 * Converts knots to kph.
 * @param {number} value - an amount in knots
 * @returns {number} the same amount in kph
 */
export function knotsToKph(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('knotsToKph: value must be a number');
  }
  return round(value * 1.852);
}

/**
 * Converts kph to knots.
 * @param {number} value - an amount in kph
 * @returns {number} the same amount in knots
 */
export function kphToKnots(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kphToKnots: value must be a number');
  }
  return round(value * 0.539957);
}

/**
 * Converts joules to calories.
 * @param {number} value - an amount in joules
 * @returns {number} the same amount in calories
 */
export function joulesToCalories(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('joulesToCalories: value must be a number');
  }
  return round(value * 0.239006);
}

/**
 * Converts calories to joules.
 * @param {number} value - an amount in calories
 * @returns {number} the same amount in joules
 */
export function caloriesToJoules(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('caloriesToJoules: value must be a number');
  }
  return round(value * 4.184);
}

/**
 * Converts kwh to joules.
 * @param {number} value - an amount in kwh
 * @returns {number} the same amount in joules
 */
export function kwhToJoules(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kwhToJoules: value must be a number');
  }
  return round(value * 3600000);
}

/**
 * Converts watts to horsepower.
 * @param {number} value - an amount in watts
 * @returns {number} the same amount in horsepower
 */
export function wattsToHorsepower(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('wattsToHorsepower: value must be a number');
  }
  return round(value * 0.00134102);
}

/**
 * Converts horsepower to watts.
 * @param {number} value - an amount in horsepower
 * @returns {number} the same amount in watts
 */
export function horsepowerToWatts(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('horsepowerToWatts: value must be a number');
  }
  return round(value * 745.7);
}

/**
 * Converts bar to psi.
 * @param {number} value - an amount in bar
 * @returns {number} the same amount in psi
 */
export function barToPsi(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('barToPsi: value must be a number');
  }
  return round(value * 14.5038);
}

/**
 * Converts psi to bar.
 * @param {number} value - an amount in psi
 * @returns {number} the same amount in bar
 */
export function psiToBar(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('psiToBar: value must be a number');
  }
  return round(value * 0.0689476);
}

/**
 * Converts atm to pascals.
 * @param {number} value - an amount in atm
 * @returns {number} the same amount in pascals
 */
export function atmToPascals(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('atmToPascals: value must be a number');
  }
  return round(value * 101325);
}

/**
 * Converts pascals to atm.
 * @param {number} value - an amount in pascals
 * @returns {number} the same amount in atm
 */
export function pascalsToAtm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('pascalsToAtm: value must be a number');
  }
  return round(value * 9.86923e-06);
}

/**
 * Converts bytes to bits.
 * @param {number} value - an amount in bytes
 * @returns {number} the same amount in bits
 */
export function bytesToBits(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('bytesToBits: value must be a number');
  }
  return round(value * 8);
}

/**
 * Converts bits to bytes.
 * @param {number} value - an amount in bits
 * @returns {number} the same amount in bytes
 */
export function bitsToBytes(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('bitsToBytes: value must be a number');
  }
  return round(value * 0.125);
}

/**
 * Converts kib to bytes.
 * @param {number} value - an amount in kib
 * @returns {number} the same amount in bytes
 */
export function kibToBytes(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kibToBytes: value must be a number');
  }
  return round(value * 1024);
}

/**
 * Converts mib to kib.
 * @param {number} value - an amount in mib
 * @returns {number} the same amount in kib
 */
export function mibToKib(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('mibToKib: value must be a number');
  }
  return round(value * 1024);
}

/**
 * Converts gib to mib.
 * @param {number} value - an amount in gib
 * @returns {number} the same amount in mib
 */
export function gibToMib(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('gibToMib: value must be a number');
  }
  return round(value * 1024);
}

/**
 * Converts hours to seconds.
 * @param {number} value - an amount in hours
 * @returns {number} the same amount in seconds
 */
export function hoursToSeconds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('hoursToSeconds: value must be a number');
  }
  return round(value * 3600);
}

/**
 * Converts days to hours.
 * @param {number} value - an amount in days
 * @returns {number} the same amount in hours
 */
export function daysToHours(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('daysToHours: value must be a number');
  }
  return round(value * 24);
}

/**
 * Converts weeks to days.
 * @param {number} value - an amount in weeks
 * @returns {number} the same amount in days
 */
export function weeksToDays(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('weeksToDays: value must be a number');
  }
  return round(value * 7);
}

/**
 * Converts minutes to seconds.
 * @param {number} value - an amount in minutes
 * @returns {number} the same amount in seconds
 */
export function minutesToSeconds(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('minutesToSeconds: value must be a number');
  }
  return round(value * 60);
}

/**
 * Converts degrees to radians.
 * @param {number} value - an amount in degrees
 * @returns {number} the same amount in radians
 */
export function degreesToRadians(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('degreesToRadians: value must be a number');
  }
  return round(value * 0.0174533);
}

/**
 * Converts radians to degrees.
 * @param {number} value - an amount in radians
 * @returns {number} the same amount in degrees
 */
export function radiansToDegrees(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('radiansToDegrees: value must be a number');
  }
  return round(value * 57.2958);
}

/**
 * Converts nauticalMiles to km.
 * @param {number} value - an amount in nauticalMiles
 * @returns {number} the same amount in km
 */
export function nauticalMilesToKm(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('nauticalMilesToKm: value must be a number');
  }
  return round(value * 1.852);
}

/**
 * Converts km to nauticalMiles.
 * @param {number} value - an amount in km
 * @returns {number} the same amount in nauticalMiles
 */
export function kmToNauticalMiles(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError('kmToNauticalMiles: value must be a number');
  }
  return round(value * 0.539957);
}
