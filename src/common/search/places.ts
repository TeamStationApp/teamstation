/**
 * How a location pill is written: `San Diego, CA`, `California`, `USA`.
 */

/**
 * The postal abbreviation of each region that has one in common use, by
 * country code and then by the region's name as the places catalog writes
 * it: US states and DC, Canadian provinces and territories, and Australian
 * states and territories.
 */
export const REGION_ABBREVIATIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  US: {
    Alabama: 'AL',
    Alaska: 'AK',
    Arizona: 'AZ',
    Arkansas: 'AR',
    California: 'CA',
    Colorado: 'CO',
    Connecticut: 'CT',
    Delaware: 'DE',
    'District of Columbia': 'DC',
    Florida: 'FL',
    Georgia: 'GA',
    Hawaii: 'HI',
    Idaho: 'ID',
    Illinois: 'IL',
    Indiana: 'IN',
    Iowa: 'IA',
    Kansas: 'KS',
    Kentucky: 'KY',
    Louisiana: 'LA',
    Maine: 'ME',
    Maryland: 'MD',
    Massachusetts: 'MA',
    Michigan: 'MI',
    Minnesota: 'MN',
    Mississippi: 'MS',
    Missouri: 'MO',
    Montana: 'MT',
    Nebraska: 'NE',
    Nevada: 'NV',
    'New Hampshire': 'NH',
    'New Jersey': 'NJ',
    'New Mexico': 'NM',
    'New York': 'NY',
    'North Carolina': 'NC',
    'North Dakota': 'ND',
    Ohio: 'OH',
    Oklahoma: 'OK',
    Oregon: 'OR',
    Pennsylvania: 'PA',
    'Rhode Island': 'RI',
    'South Carolina': 'SC',
    'South Dakota': 'SD',
    Tennessee: 'TN',
    Texas: 'TX',
    Utah: 'UT',
    Vermont: 'VT',
    Virginia: 'VA',
    Washington: 'WA',
    'West Virginia': 'WV',
    Wisconsin: 'WI',
    Wyoming: 'WY'
  },
  CA: {
    Alberta: 'AB',
    'British Columbia': 'BC',
    Manitoba: 'MB',
    'New Brunswick': 'NB',
    'Newfoundland and Labrador': 'NL',
    'Northwest Territories': 'NT',
    'Nova Scotia': 'NS',
    Nunavut: 'NU',
    Ontario: 'ON',
    'Prince Edward Island': 'PE',
    Quebec: 'QC',
    Saskatchewan: 'SK',
    Yukon: 'YT'
  },
  AU: {
    'Australian Capital Territory': 'ACT',
    'New South Wales': 'NSW',
    'Northern Territory': 'NT',
    Queensland: 'QLD',
    'South Australia': 'SA',
    Tasmania: 'TAS',
    Victoria: 'VIC',
    'Western Australia': 'WA'
  }
}

/** Countries better known by an abbreviation than by their full name. */
export const COUNTRY_ABBREVIATIONS: Readonly<Record<string, string>> = {
  US: 'USA',
  GB: 'UK',
  AE: 'UAE'
}

/** A region's abbreviation, or undefined when it has none. */
export function regionAbbreviation(
  country: string,
  region: string
): string | undefined {
  const regions = REGION_ABBREVIATIONS[country.toUpperCase()]
  return regions == null || !Object.hasOwn(regions, region)
    ? undefined
    : regions[region]
}

/** A country's name in English, from its ISO 3166 code. */
export function countryName(country: string): string {
  const code = country.toUpperCase()
  if (Object.hasOwn(COUNTRY_ABBREVIATIONS, code))
    return COUNTRY_ABBREVIATIONS[code]
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    // A runtime without `Intl.DisplayNames`, or a code it rejects.
    return code
  }
}

/** What a pill is written from. */
export interface LabelledPlace {
  kind: 'city' | 'region' | 'country'
  city?: string
  region?: string
  /** The ISO 3166 code. */
  country: string
}

/**
 * A pill's text: a city as `City, AB` (or `City, Region` for a region with
 * no abbreviation), a region by its full name, a country by its name.
 */
export function placeLabel(place: LabelledPlace): string {
  const region = place.region ?? ''
  const city = place.kind === 'city' ? (place.city ?? '') : ''
  if (place.kind === 'country' || (region === '' && city === ''))
    return countryName(place.country)
  if (city === '') return region
  if (region === '') return city
  return `${city}, ${regionAbbreviation(place.country, region) ?? region}`
}
