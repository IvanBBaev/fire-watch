/**
 * MeteoAlarm bodies for the V2-B3 tests.
 *
 * Kept as TypeScript strings, not `.xml` files, because a core test may not read the
 * filesystem (`server-core-has-no-platform`).
 *
 * **Recorded** (fetched 2026-10-24 at 00:08 UTC, bodies as served):
 *
 *   * {@link GREECE_FEED} — `meteoalarm-legacy-atom-greece`, twelve real entries (fog,
 *     thunderstorm, rain): every one is out of scope, so it exercises the drop path.
 *   * {@link BULGARIA_FEED_EMPTY} — `meteoalarm-legacy-atom-bulgaria`, no entries.
 *   * {@link CAP_GREECE_FOG} — the CAP alert behind the first Greek entry (`en-GB` and
 *     `el-GR` info blocks, `awareness_type` 4; Fog).
 *
 * **Synthetic** — no fire or heat warning was in force in any polled country on the day
 * the feeds were recorded, so the in-scope cases are hand-built in the recorded shape.
 * They are labelled `SYNTHETIC_*`, their identifiers say `synthetic`, and their dates
 * (2026-08-14) are invented. EMMA_IDs and region names are illustrative only.
 */

export const RECORDED_AT_MS = Date.UTC(2026, 9, 24, 0, 8, 35);

export const GREECE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
  <link type="application/atom+xml" rel="self" href="https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece"/>
  <link type="text/html" rel="alternate" href="https://meteoalarm.org"/>
  <rights>Copyright © 2026 MeteoAlarm.Org. Licensed under terms equivalent to CC BY 4.0, with additional requirements for redistributing outlined in our Terms and Conditions.</rights>
  <generator>MeteoAlarm Producer Server</generator>
  <logo>https://feeds.meteoalarm.org/images/logo.svg</logo>
  <author>
    <name>meteoalarm.org</name>
    <uri>https://meteoalarm.org</uri>
    <email>meteoalarm@geosphere.at</email>
  </author>
  <id>tag:meteoalarm.org,2021-02-19:GR</id>
  <title>MeteoAlarm - Alerting Europe for Extreme Weather</title>
  <updated>2026-10-24T00:05:28.771488Z</updated>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR014</value>
    </cap:geocode>
    <link title="North East Aegean Islands" href="https://meteoalarm.org?geocode=EMMA_ID:GR014" hreflang="en"/>
    <cap:areaDesc>North East Aegean Islands</cap:areaDesc>
    <cap:event>Moderate Fog warning</cap:event>
    <cap:sent>2026-10-23T11:06:00+00:00</cap:sent>
    <cap:expires>2026-10-24T05:00:00+00:00</cap:expires>
    <cap:effective>2026-10-23T11:06:00+00:00</cap:effective>
    <cap:onset>2026-10-24T00:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261023110600.000100014</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/7741ad66-f6d0-4dea-b058-b8ccfb8ab999"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-23T11:06:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/7741ad66-f6d0-4dea-b058-b8ccfb8ab999?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Fog Warning issued for Greece - North East Aegean Islands</title>
    <updated>2026-10-23T11:06:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR013</value>
    </cap:geocode>
    <link title="Dodekanisa Islands" href="https://meteoalarm.org?geocode=EMMA_ID:GR013" hreflang="en"/>
    <cap:areaDesc>Dodekanisa Islands</cap:areaDesc>
    <cap:event>Moderate Fog warning</cap:event>
    <cap:sent>2026-10-23T11:06:00+00:00</cap:sent>
    <cap:expires>2026-10-24T05:00:00+00:00</cap:expires>
    <cap:effective>2026-10-23T11:06:00+00:00</cap:effective>
    <cap:onset>2026-10-24T00:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261023110600.000100013</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/a7cb7bf5-9518-4e34-ac99-939183f4147c"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-23T11:06:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/a7cb7bf5-9518-4e34-ac99-939183f4147c?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Fog Warning issued for Greece - Dodekanisa Islands</title>
    <updated>2026-10-23T11:06:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR002</value>
    </cap:geocode>
    <link title="West Sterea" href="https://meteoalarm.org?geocode=EMMA_ID:GR002" hreflang="en"/>
    <cap:areaDesc>West Sterea</cap:areaDesc>
    <cap:event>Moderate Fog warning</cap:event>
    <cap:sent>2026-10-22T12:06:00+00:00</cap:sent>
    <cap:expires>2026-10-23T04:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T12:06:00+00:00</cap:effective>
    <cap:onset>2026-10-22T22:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022120600.000100002</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/dbf02677-5bad-4977-9949-f88b65ec3095"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T12:06:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/dbf02677-5bad-4977-9949-f88b65ec3095?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Fog Warning issued for Greece - West Sterea</title>
    <updated>2026-10-22T12:06:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR008</value>
    </cap:geocode>
    <link title="Epirus" href="https://meteoalarm.org?geocode=EMMA_ID:GR008" hreflang="en"/>
    <cap:areaDesc>Epirus</cap:areaDesc>
    <cap:event>Moderate Fog warning</cap:event>
    <cap:sent>2026-10-22T12:06:00+00:00</cap:sent>
    <cap:expires>2026-10-23T04:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T12:06:00+00:00</cap:effective>
    <cap:onset>2026-10-22T22:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022120600.000100008</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/d0c73dc2-56fd-4924-a2d5-3149df239d66"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T12:06:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/d0c73dc2-56fd-4924-a2d5-3149df239d66?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Fog Warning issued for Greece - Epirus</title>
    <updated>2026-10-22T12:06:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR007</value>
    </cap:geocode>
    <link title="Central Makedonia" href="https://meteoalarm.org?geocode=EMMA_ID:GR007" hreflang="en"/>
    <cap:areaDesc>Central Makedonia</cap:areaDesc>
    <cap:event>Moderate Thunderstorm warning</cap:event>
    <cap:sent>2026-10-22T12:03:00+00:00</cap:sent>
    <cap:expires>2026-10-23T06:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T12:03:00+00:00</cap:effective>
    <cap:onset>2026-10-22T23:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022120300.010000007</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/41ac1b2d-935c-4ecd-86d7-ce8ac3742dc6"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T12:03:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/41ac1b2d-935c-4ecd-86d7-ce8ac3742dc6?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Thunderstorm Warning issued for Greece - Central Makedonia</title>
    <updated>2026-10-22T12:03:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR007</value>
    </cap:geocode>
    <link title="Central Makedonia" href="https://meteoalarm.org?geocode=EMMA_ID:GR007" hreflang="en"/>
    <cap:areaDesc>Central Makedonia</cap:areaDesc>
    <cap:event>Moderate Rain warning</cap:event>
    <cap:sent>2026-10-22T11:54:00+00:00</cap:sent>
    <cap:expires>2026-10-23T07:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:54:00+00:00</cap:effective>
    <cap:onset>2026-10-22T22:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022115400.001000007</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/94258793-abd4-4ce8-9573-c8d40e5fcf33"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:54:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/94258793-abd4-4ce8-9573-c8d40e5fcf33?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Rain Warning issued for Greece - Central Makedonia</title>
    <updated>2026-10-22T11:54:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR014</value>
    </cap:geocode>
    <link title="North East Aegean Islands" href="https://meteoalarm.org?geocode=EMMA_ID:GR014" hreflang="en"/>
    <cap:areaDesc>North East Aegean Islands</cap:areaDesc>
    <cap:event>Moderate Thunderstorm warning</cap:event>
    <cap:sent>2026-10-22T11:35:00+00:00</cap:sent>
    <cap:expires>2026-10-23T17:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:35:00+00:00</cap:effective>
    <cap:onset>2026-10-23T04:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022113500.010000014</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/a200566a-28c0-462b-97b4-c78c24ac1b59"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:35:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/a200566a-28c0-462b-97b4-c78c24ac1b59?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Thunderstorm Warning issued for Greece - North East Aegean Islands</title>
    <updated>2026-10-22T11:35:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR005</value>
    </cap:geocode>
    <link title="East Makedonia" href="https://meteoalarm.org?geocode=EMMA_ID:GR005" hreflang="en"/>
    <cap:areaDesc>East Makedonia</cap:areaDesc>
    <cap:event>Moderate Thunderstorm warning</cap:event>
    <cap:sent>2026-10-22T11:35:00+00:00</cap:sent>
    <cap:expires>2026-10-23T17:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:35:00+00:00</cap:effective>
    <cap:onset>2026-10-23T04:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022113500.010000005</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/85b003af-8055-4f46-81e5-f82c40838eb5"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:35:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/85b003af-8055-4f46-81e5-f82c40838eb5?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Thunderstorm Warning issued for Greece - East Makedonia</title>
    <updated>2026-10-22T11:35:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR014</value>
    </cap:geocode>
    <link title="North East Aegean Islands" href="https://meteoalarm.org?geocode=EMMA_ID:GR014" hreflang="en"/>
    <cap:areaDesc>North East Aegean Islands</cap:areaDesc>
    <cap:event>Moderate Rain warning</cap:event>
    <cap:sent>2026-10-22T11:18:00+00:00</cap:sent>
    <cap:expires>2026-10-23T18:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:18:00+00:00</cap:effective>
    <cap:onset>2026-10-23T04:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022111800.001000014</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/24359063-f209-43c1-8d47-9ecd0b9dac73"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:18:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/24359063-f209-43c1-8d47-9ecd0b9dac73?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Rain Warning issued for Greece - North East Aegean Islands</title>
    <updated>2026-10-22T11:18:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR005</value>
    </cap:geocode>
    <link title="East Makedonia" href="https://meteoalarm.org?geocode=EMMA_ID:GR005" hreflang="en"/>
    <cap:areaDesc>East Makedonia</cap:areaDesc>
    <cap:event>Moderate Rain warning</cap:event>
    <cap:sent>2026-10-22T11:18:00+00:00</cap:sent>
    <cap:expires>2026-10-23T18:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:18:00+00:00</cap:effective>
    <cap:onset>2026-10-23T04:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022111800.001000005</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/4c82c398-0e82-4437-a4ee-8b88439ec211"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:18:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/4c82c398-0e82-4437-a4ee-8b88439ec211?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Rain Warning issued for Greece - East Makedonia</title>
    <updated>2026-10-22T11:18:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR004</value>
    </cap:geocode>
    <link title="Thraki" href="https://meteoalarm.org?geocode=EMMA_ID:GR004" hreflang="en"/>
    <cap:areaDesc>Thraki</cap:areaDesc>
    <cap:event>Moderate Thunderstorm warning</cap:event>
    <cap:sent>2026-10-22T11:35:00+00:00</cap:sent>
    <cap:expires>2026-10-23T17:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:35:00+00:00</cap:effective>
    <cap:onset>2026-10-23T04:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022113500.010000004</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/6f45cb9e-2c48-400a-804f-b6bfd04d4f9a"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:35:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/6f45cb9e-2c48-400a-804f-b6bfd04d4f9a?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Thunderstorm Warning issued for Greece - Thraki</title>
    <updated>2026-10-22T11:35:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>GR004</value>
    </cap:geocode>
    <link title="Thraki" href="https://meteoalarm.org?geocode=EMMA_ID:GR004" hreflang="en"/>
    <cap:areaDesc>Thraki</cap:areaDesc>
    <cap:event>Moderate Rain warning</cap:event>
    <cap:sent>2026-10-22T11:18:00+00:00</cap:sent>
    <cap:expires>2026-10-23T18:00:00+00:00</cap:expires>
    <cap:effective>2026-10-22T11:18:00+00:00</cap:effective>
    <cap:onset>2026-10-23T04:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>2.49.0.0.300.0.GR.261022111800.001000004</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/0d08d6c6-838c-44a0-a663-bc7023d99c51"/>
    <link title="Greece" rel="related" href="https://meteoalarm.org?region=GR" hreflang="en"/>
    <author>
      <name>meteoalarm.org</name>
      <uri>https://meteoalarm.org</uri>
    </author>
    <published>2026-10-22T11:18:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece/0d08d6c6-838c-44a0-a663-bc7023d99c51?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Rain Warning issued for Greece - Thraki</title>
    <updated>2026-10-22T11:18:00Z</updated>
  </entry>
</feed>`;

export const BULGARIA_FEED_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
  <link type="application/atom+xml" rel="self" href="https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-bulgaria"/>
  <link type="text/html" rel="alternate" href="https://meteoalarm.org"/>
  <rights>Copyright © 2026 MeteoAlarm.Org. Licensed under terms equivalent to CC BY 4.0, with additional requirements for redistributing outlined in our Terms and Conditions.</rights>
  <generator>MeteoAlarm Producer Server</generator>
  <logo>https://feeds.meteoalarm.org/images/logo.svg</logo>
  <author>
    <name>meteoalarm.org</name>
    <uri>https://meteoalarm.org</uri>
    <email>meteoalarm@geosphere.at</email>
  </author>
  <id>tag:meteoalarm.org,2021-02-19:BG</id>
  <title>MeteoAlarm - Alerting Europe for Extreme Weather</title>
  <updated>2026-10-24T00:05:04.292771Z</updated>
</feed>`;

export const CAP_GREECE_FOG = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>2.49.0.0.300.0.GR.261023110600.000100014</identifier>
  <sender>emk@hnms.gr</sender>
  <sent>2026-10-23T11:06:00+00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Moderate Fog warning</event>
    <responseType>None</responseType>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <effective>2026-10-23T11:06:00+00:00</effective>
    <onset>2026-10-24T00:00:00+00:00</onset>
    <expires>2026-10-24T05:00:00+00:00</expires>
    <senderName>Hnms Forecaster</senderName>
    <headline>Yellow warning for North East Aegean Islands</headline>
    <description>Locally poor visibility due to fog. BE AWARE of some widespread, locally dense fog. May strongly affect outdoor routines. Can cause airport closures and delays, difficult driving conditions and longer journey times.</description>
    <web>https://www.emy.gr</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>4; Fog</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>2; Yellow; Moderate</value>
    </parameter>
    <area>
      <areaDesc>North East Aegean Islands</areaDesc>
      <geocode>
        <valueName>EMMA_ID</valueName>
        <value>GR014</value>
      </geocode>
    </area>
  </info>
  <info>
    <language>el-GR</language>
    <category>Met</category>
    <event>Προειδοποίηση για Ομίχλη</event>
    <responseType>None</responseType>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <effective>2026-10-23T11:06:00+00:00</effective>
    <onset>2026-10-24T00:00:00+00:00</onset>
    <expires>2026-10-24T05:00:00+00:00</expires>
    <senderName>Hnms Forecaster</senderName>
    <headline>Κίτρινη προειδοποίηση για Νησιά Βορειοανατολικού Αιγαίου</headline>
    <description>Τοπικά περιορισμένη ορατότητα λόγω ομίχλης. ΕΝΗΜΕΡΩΘΕΙΤΕ για εκτεταμένες και κατά τόπους πυκνές ομίχλες. Μπορεί να επηρεαστούν σημαντικά οι υπαίθριες δραστηριότητες. Πιθανό κλείσιμο αεροδρομίων, καθυστερήσεις σε πτήσεις, δύσκολες συνθήκες οδήγησης και μεγαλύτερη διάρκεια στα ταξίδια.</description>
    <web>https://www.emy.gr</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>4; Fog</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>2; Yellow; Moderate</value>
    </parameter>
    <area>
      <areaDesc>Νησιά Βορειοανατολικού Αιγαίου</areaDesc>
      <geocode>
        <valueName>EMMA_ID</valueName>
        <value>GR014</value>
      </geocode>
    </area>
  </info>
</alert>`;

/** "Now" for the synthetic cases: inside the fire and heat warnings' validity. */
export const SYNTHETIC_NOW_MS = Date.UTC(2026, 7, 14, 12, 0, 0);

/**
 * A Bulgarian feed with, in order: an orange forest-fire warning, a yellow high-temperature
 * warning, a yellow wind warning (dropped by title), an expired red forest-fire warning, a
 * cancelled orange one, and a "Dust" title this reader cannot place (its CAP says rain-flood).
 */
export const SYNTHETIC_BULGARIA_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <link rel="hub" href="https://pubsubhubbub.appspot.com/"/>
  <link type="application/atom+xml" rel="self" href="https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-bulgaria"/>
  <link type="text/html" rel="alternate" href="https://meteoalarm.org"/>
  <rights>Copyright © 2026 MeteoAlarm.Org. Licensed under terms equivalent to CC BY 4.0, with additional requirements for redistributing outlined in our Terms and Conditions.</rights>
  <generator>MeteoAlarm Producer Server</generator>
  <logo>https://feeds.meteoalarm.org/images/logo.svg</logo>
  <author>
    <name>meteoalarm.org</name>
    <uri>https://meteoalarm.org</uri>
    <email>meteoalarm@geosphere.at</email>
  </author>
  <id>tag:meteoalarm.org,2021-02-19:BG</id>
  <title>MeteoAlarm - Alerting Europe for Extreme Weather</title>
  <updated>2026-08-14T06:05:00.000000Z</updated>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>BG009</value>
    </cap:geocode>
    <link title="Haskovo" href="https://meteoalarm.org?geocode=EMMA_ID:BG009" hreflang="en"/>
    <cap:areaDesc>Haskovo</cap:areaDesc>
    <cap:event>Severe forest-fire warning</cap:event>
    <cap:sent>2026-08-14T06:00:00+00:00</cap:sent>
    <cap:expires>2026-08-15T21:00:00+00:00</cap:expires>
    <cap:effective>2026-08-14T06:00:00+00:00</cap:effective>
    <cap:onset>2026-08-14T09:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Severe</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>synthetic.fire</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000001"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
    <published>2026-08-14T06:00:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000001?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Orange Forest Fire Warning issued for Bulgaria - Haskovo</title>
    <updated>2026-08-14T06:00:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>BG010</value>
    </cap:geocode>
    <link title="Kardzhali" href="https://meteoalarm.org?geocode=EMMA_ID:BG010" hreflang="en"/>
    <cap:areaDesc>Kardzhali</cap:areaDesc>
    <cap:event>Moderate high-temperature warning</cap:event>
    <cap:sent>2026-08-14T06:00:00+00:00</cap:sent>
    <cap:expires>2026-08-15T18:00:00+00:00</cap:expires>
    <cap:effective>2026-08-14T06:00:00+00:00</cap:effective>
    <cap:onset>2026-08-14T09:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>synthetic.heat</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000002"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
    <published>2026-08-14T06:00:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000002?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow High Temperature Warning issued for Bulgaria - Kardzhali</title>
    <updated>2026-08-14T06:00:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>BG011</value>
    </cap:geocode>
    <link title="Burgas" href="https://meteoalarm.org?geocode=EMMA_ID:BG011" hreflang="en"/>
    <cap:areaDesc>Burgas</cap:areaDesc>
    <cap:event>Moderate wind warning</cap:event>
    <cap:sent>2026-08-14T06:00:00+00:00</cap:sent>
    <cap:expires>2026-08-15T18:00:00+00:00</cap:expires>
    <cap:effective>2026-08-14T06:00:00+00:00</cap:effective>
    <cap:onset>2026-08-14T09:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>synthetic.wind</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000003"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
    <published>2026-08-14T06:00:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000003?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Wind Warning issued for Bulgaria - Burgas</title>
    <updated>2026-08-14T06:00:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>BG012</value>
    </cap:geocode>
    <link title="Smolyan" href="https://meteoalarm.org?geocode=EMMA_ID:BG012" hreflang="en"/>
    <cap:areaDesc>Smolyan</cap:areaDesc>
    <cap:event>Extreme forest-fire warning</cap:event>
    <cap:sent>2026-08-14T06:00:00+00:00</cap:sent>
    <cap:expires>2026-08-13T21:00:00+00:00</cap:expires>
    <cap:effective>2026-08-14T06:00:00+00:00</cap:effective>
    <cap:onset>2026-08-12T09:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Extreme</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>synthetic.expired</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000004"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
    <published>2026-08-14T06:00:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000004?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Red Forest Fire Warning issued for Bulgaria - Smolyan</title>
    <updated>2026-08-14T06:00:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>BG013</value>
    </cap:geocode>
    <link title="Blagoevgrad" href="https://meteoalarm.org?geocode=EMMA_ID:BG013" hreflang="en"/>
    <cap:areaDesc>Blagoevgrad</cap:areaDesc>
    <cap:event>Severe forest-fire warning</cap:event>
    <cap:sent>2026-08-14T06:00:00+00:00</cap:sent>
    <cap:expires>2026-08-15T21:00:00+00:00</cap:expires>
    <cap:effective>2026-08-14T06:00:00+00:00</cap:effective>
    <cap:onset>2026-08-14T09:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Severe</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Cancel</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>synthetic.cancel</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000005"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
    <published>2026-08-14T06:00:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000005?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Orange Forest Fire Warning issued for Bulgaria - Blagoevgrad</title>
    <updated>2026-08-14T06:00:00Z</updated>
  </entry>
  <entry>
    <cap:geocode>
      <valueName>EMMA_ID</valueName>
      <value>BG014</value>
    </cap:geocode>
    <link title="Sliven" href="https://meteoalarm.org?geocode=EMMA_ID:BG014" hreflang="en"/>
    <cap:areaDesc>Sliven</cap:areaDesc>
    <cap:event>Moderate warning</cap:event>
    <cap:sent>2026-08-14T06:00:00+00:00</cap:sent>
    <cap:expires>2026-08-15T18:00:00+00:00</cap:expires>
    <cap:effective>2026-08-14T06:00:00+00:00</cap:effective>
    <cap:onset>2026-08-14T09:00:00+00:00</cap:onset>
    <cap:certainty>Likely</cap:certainty>
    <cap:severity>Moderate</cap:severity>
    <cap:urgency>Expected</cap:urgency>
    <cap:scope>Public</cap:scope>
    <cap:message_type>Alert</cap:message_type>
    <cap:status>Actual</cap:status>
    <cap:identifier>synthetic.odd</cap:identifier>
    <link type="application/cap+xml" href="https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000006"/>
    <link title="Bulgaria" rel="related" href="https://meteoalarm.org?region=BG" hreflang="en"/>
    <published>2026-08-14T06:00:00Z</published>
    <id>https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000006?index_info=0&amp;index_area=0&amp;index_geocode=0</id>
    <title>Yellow Dust Warning issued for Bulgaria - Sliven</title>
    <updated>2026-08-14T06:00:00Z</updated>
  </entry>
</feed>`;

export const SYNTHETIC_CAP_FIRE_URL =
  'https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000001';
export const SYNTHETIC_CAP_HEAT_URL =
  'https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000002';
export const SYNTHETIC_CAP_DUST_URL =
  'https://feeds.meteoalarm.org/api/v1/warnings/feeds-bulgaria/00000000-0000-4000-8000-000000000006';

/** Bulgarian info block first, English second — the reader must pick the English one. */
export const SYNTHETIC_CAP_FIRE = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>synthetic.BG009</identifier>
  <sender>synthetic@example.invalid</sender>
  <sent>2026-08-14T06:00:00+00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>bg-BG</language>
    <category>Met</category>
    <event>Предупреждение</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <headline>Предупреждение за Haskovo</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>8; forest-fire</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>3; orange; Severe</value>
    </parameter>
  </info>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Severe forest-fire warning</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <expires>2026-08-15T21:00:00+00:00</expires>
    <headline>Orange forest-fire warning for Haskovo</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>8; forest-fire</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>3; orange; Severe</value>
    </parameter>
    <area>
      <areaDesc>Haskovo</areaDesc>
      <geocode>
        <valueName>EMMA_ID</valueName>
        <value>BG009</value>
      </geocode>
    </area>
  </info>
</alert>`;

export const SYNTHETIC_CAP_HEAT = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>synthetic.BG010</identifier>
  <sender>synthetic@example.invalid</sender>
  <sent>2026-08-14T06:00:00+00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>bg-BG</language>
    <category>Met</category>
    <event>Предупреждение</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <headline>Предупреждение за Kardzhali</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>5; high-temperature</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>2; yellow; Moderate</value>
    </parameter>
  </info>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Moderate high-temperature warning</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <expires>2026-08-15T21:00:00+00:00</expires>
    <headline>Yellow high-temperature warning for Kardzhali</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>5; high-temperature</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>2; yellow; Moderate</value>
    </parameter>
    <area>
      <areaDesc>Kardzhali</areaDesc>
      <geocode>
        <valueName>EMMA_ID</valueName>
        <value>BG010</value>
      </geocode>
    </area>
  </info>
</alert>`;

export const SYNTHETIC_CAP_DUST = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>synthetic.BG014</identifier>
  <sender>synthetic@example.invalid</sender>
  <sent>2026-08-14T06:00:00+00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>bg-BG</language>
    <category>Met</category>
    <event>Предупреждение</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <headline>Предупреждение за Sliven</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>13; rain-flood</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>2; yellow; Moderate</value>
    </parameter>
  </info>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Moderate dust warning</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <expires>2026-08-15T21:00:00+00:00</expires>
    <headline>Yellow warning for Sliven</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value>13; rain-flood</value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>2; yellow; Moderate</value>
    </parameter>
    <area>
      <areaDesc>Sliven</areaDesc>
      <geocode>
        <valueName>EMMA_ID</valueName>
        <value>BG014</value>
      </geocode>
    </area>
  </info>
</alert>`;

/** No awareness_type value, an OET-095 Grass Fire event code instead. */
export const SYNTHETIC_CAP_OET_GRASS_FIRE = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>synthetic.BG015</identifier>
  <sender>synthetic@example.invalid</sender>
  <sent>2026-08-14T06:00:00+00:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>bg-BG</language>
    <category>Met</category>
    <event>Предупреждение</event>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <headline>Предупреждение за Yambol</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value></value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>3; orange; Severe</value>
    </parameter>
  </info>
  <info>
    <language>en-GB</language>
    <category>Met</category>
    <event>Grass fire warning</event>
    <eventCode>
      <valueName>OET:v1.2</valueName>
      <value>OET-095</value>
    </eventCode>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <expires>2026-08-15T21:00:00+00:00</expires>
    <headline>Orange grass-fire warning</headline>
    <web>https://www.meteo.bg</web>
    <parameter>
      <valueName>awareness_type</valueName>
      <value></value>
    </parameter>
    <parameter>
      <valueName>awareness_level</valueName>
      <value>3; orange; Severe</value>
    </parameter>
    <area>
      <areaDesc>Yambol</areaDesc>
      <geocode>
        <valueName>EMMA_ID</valueName>
        <value>BG015</value>
      </geocode>
    </area>
  </info>
</alert>`;
