# Third-party notices

Radio Dunya bundles the following small browser libraries and map data locally. There are no runtime CDN requests for these assets.

| Component | Version | Local file | License |
| --- | --- | --- | --- |
| [d3-array](https://github.com/d3/d3-array/tree/v3.2.4) | 3.2.4 | `vendor/d3-array.min.js` | [ISC](vendor/d3-array-LICENSE.txt) |
| [d3-geo](https://github.com/d3/d3-geo/tree/v3.1.1) | 3.1.1 | `vendor/d3-geo.min.js` | [ISC, plus GeographicLib MIT notice](vendor/d3-geo-LICENSE.txt) |
| [topojson-client](https://github.com/topojson/topojson-client/tree/v3.1.0) | 3.1.0 | `vendor/topojson-client.min.js` | [ISC](vendor/topojson-client-LICENSE.txt) |
| [world-atlas](https://github.com/topojson/world-atlas/tree/v2.0.2) | 2.0.2 | `assets/countries-110m.json` | [ISC redistribution](vendor/world-atlas-LICENSE.txt); underlying map data is public domain |

The JavaScript distributions and original complete license texts were downloaded from version-pinned npm packages through `https://cdn.jsdelivr.net/npm/`. Minified library headers retain the upstream attribution. The adjacent license files contain the applicable copyright, permission, and warranty notices.

The globe uses [Natural Earth](https://www.naturalearthdata.com/) country boundaries and merged land geometry at 1:110 million scale, redistributed by world-atlas. It loads the single `countries-110m.json` asset and derives interior borders from shared country edges. [Natural Earth's terms](https://www.naturalearthdata.com/about/terms-of-use/) place its raster and vector map data in the public domain. Made with Natural Earth.

Station listings and stream links come from the community [Radio Browser directory](https://www.radio-browser.info/), whose website dedicates its accumulated station data to the public domain. [API documentation](https://docs.radio-browser.info/). Audio remains provided by the individual broadcasters, who retain their applicable rights. Radio Dunya is independent of Radio Garden and Radio Browser.

The approximate-location helper bundles country component extents (`assets/country-bounds.json`, with a 50 km coast/border margin) and city/capital points (`assets/station-places.json`). They are derived from Natural Earth [10m countries](https://github.com/nvkelso/natural-earth-vector/blob/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_10m_admin_0_countries.geojson), [populated places](https://github.com/nvkelso/natural-earth-vector/blob/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_10m_populated_places.geojson), and [map units](https://github.com/nvkelso/natural-earth-vector/blob/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_10m_admin_0_map_units.geojson), pinned to commit `9380cca83db5f9aef52d5e762765100745f84b27`. These data are public domain under the Natural Earth terms linked above. Name matches and capital fallbacks are approximate locations, not verified station addresses. A few corrected country labels include supporting source links and inference notes in the data.
