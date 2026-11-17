import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  COUNTRY_ABBREVIATIONS,
  countryName,
  placeLabel,
  REGION_ABBREVIATIONS,
  regionAbbreviation
} from './places'

describe('REGION_ABBREVIATIONS', function () {
  it('covers US states and DC, Canada and Australia', function () {
    expect(Object.keys(REGION_ABBREVIATIONS.US)).lengthOf(51)
    expect(Object.keys(REGION_ABBREVIATIONS.CA)).lengthOf(13)
    expect(Object.keys(REGION_ABBREVIATIONS.AU)).lengthOf(8)
    expect(REGION_ABBREVIATIONS.US['District of Columbia']).equals('DC')
  })
})

describe('regionAbbreviation', function () {
  it('reads by country and region', function () {
    expect(regionAbbreviation('US', 'California')).equals('CA')
    expect(regionAbbreviation('us', 'California')).equals('CA')
    expect(regionAbbreviation('CA', 'Quebec')).equals('QC')
    expect(regionAbbreviation('AU', 'Western Australia')).equals('WA')
  })

  it('has none for another country or an unknown region', function () {
    expect(regionAbbreviation('GE', 'Georgia')).equals(undefined)
    expect(regionAbbreviation('US', 'Demo State')).equals(undefined)
    expect(regionAbbreviation('US', 'toString')).equals(undefined)
  })
})

describe('countryName', function () {
  it('uses the abbreviations first', function () {
    expect(COUNTRY_ABBREVIATIONS).deep.equals({
      US: 'USA',
      GB: 'UK',
      AE: 'UAE'
    })
    expect(countryName('US')).equals('USA')
    expect(countryName('gb')).equals('UK')
    expect(countryName('AE')).equals('UAE')
  })

  it('names the rest in English', function () {
    expect(countryName('CA')).equals('Canada')
    expect(countryName('DE')).equals('Germany')
  })

  it('falls back to the code', function () {
    expect(countryName('not a code')).equals('NOT A CODE')
    const intl = Intl as { DisplayNames?: unknown }
    const displayNames = intl.DisplayNames
    try {
      intl.DisplayNames = undefined
      expect(countryName('CA')).equals('CA')
    } finally {
      intl.DisplayNames = displayNames
    }
  })
})

describe('placeLabel', function () {
  it('writes a city with its region abbreviation', function () {
    expect(
      placeLabel({
        kind: 'city',
        city: 'San Diego',
        region: 'California',
        country: 'US'
      })
    ).equals('San Diego, CA')
    expect(
      placeLabel({
        kind: 'city',
        city: 'Demo City',
        region: 'Ontario',
        country: 'CA'
      })
    ).equals('Demo City, ON')
  })

  it('writes a city with its full region when it has no abbreviation', function () {
    expect(
      placeLabel({
        kind: 'city',
        city: 'Demo City',
        region: 'Demo Region',
        country: 'DE'
      })
    ).equals('Demo City, Demo Region')
  })

  it('writes a city with no region alone', function () {
    expect(
      placeLabel({ kind: 'city', city: 'Demo City', country: 'SG' })
    ).equals('Demo City')
  })

  it('writes a region by its full name', function () {
    expect(
      placeLabel({ kind: 'region', region: 'California', country: 'US' })
    ).equals('California')
    // A region kind never shows a city.
    expect(
      placeLabel({
        kind: 'region',
        city: 'San Diego',
        region: 'California',
        country: 'US'
      })
    ).equals('California')
  })

  it('writes a country by its name', function () {
    expect(placeLabel({ kind: 'country', country: 'US' })).equals('USA')
    expect(
      placeLabel({ kind: 'country', region: 'Ontario', country: 'CA' })
    ).equals('Canada')
    // Nothing else to show.
    expect(placeLabel({ kind: 'region', country: 'CA' })).equals('Canada')
    expect(placeLabel({ kind: 'city', country: 'CA' })).equals('Canada')
  })
})
