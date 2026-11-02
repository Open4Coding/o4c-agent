import assert from 'node:assert/strict';
import { check, finish, load, original, read } from '../../lib/check.mjs';

const TABLE = [["mmToCm", 0.1], ["cmToMm", 10], ["cmToInches", 0.393701], ["inchesToCm", 2.54], ["mToFeet", 3.28084], ["feetToM", 0.3048], ["kmToMiles", 0.621371], ["milesToKm", 1.609344], ["mToYards", 1.09361], ["yardsToM", 0.9144], ["gramsToOunces", 0.035274], ["ouncesToGrams", 28.3495], ["kgToPounds", 2.20462], ["poundsToKg", 0.453592], ["stonesToKg", 6.35029], ["kgToStones", 0.157473], ["tonnesToPounds", 2204.62], ["poundsToTonnes", 0.000453592], ["litresToGallons", 0.264172], ["gallonsToLitres", 3.78541], ["mlToTeaspoons", 0.202884], ["teaspoonsToMl", 4.92892], ["mlToTablespoons", 0.067628], ["tablespoonsToMl", 14.7868], ["cupsToMl", 236.588], ["mlToCups", 0.00422675], ["pintsToLitres", 0.473176], ["litresToPints", 2.11338], ["quartsToLitres", 0.946353], ["litresToQuarts", 1.05669], ["acresToHectares", 0.404686], ["hectaresToAcres", 2.47105], ["sqmToSqft", 10.7639], ["sqftToSqm", 0.092903], ["kphToMph", 0.621371], ["mphToKph", 1.609344], ["knotsToKph", 1.852], ["kphToKnots", 0.539957], ["joulesToCalories", 0.239006], ["caloriesToJoules", 4.184], ["kwhToJoules", 3600000], ["wattsToHorsepower", 0.00134102], ["horsepowerToWatts", 745.7], ["barToPsi", 14.5038], ["psiToBar", 0.0689476], ["atmToPascals", 101325], ["pascalsToAtm", 9.86923e-06], ["bytesToBits", 8], ["bitsToBytes", 0.125], ["kibToBytes", 1024], ["mibToKib", 1024], ["gibToMib", 1024], ["hoursToSeconds", 3600], ["daysToHours", 24], ["weeksToDays", 7], ["minutesToSeconds", 60], ["degreesToRadians", 0.0174533], ["radiansToDegrees", 57.2958], ["nauticalMilesToKm", 1.852], ["kmToNauticalMiles", 0.539957]];
await check('ounces to grams', async () => assert.equal((await load('src/index.js')).ouncesToGrams(10), 283.495));
await check('every conversion still right', async () => {
  const m = await load('src/units.js');
  for (const [name, factor] of TABLE) assert.equal(m[name](3), Math.round(3 * factor * 10000) / 10000, name);
});
await check('only one line changed', () => {
  const before = original(import.meta.url, 'src/units.js').split('\n');
  const after = read('src/units.js').split('\n');
  assert.equal(after.length, before.length);
  assert.equal(after.filter((l, i) => l !== before[i]).length, 1);
});
finish();
