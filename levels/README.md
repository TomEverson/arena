# levels

Level data as JSON, loaded by both client (rendering, prediction) and server
(authoritative collision). See `example.json` for the shape: `boxes`, `ramps`,
`controlPoints`, `spawnZones`. Units are metres; Y is up.

`teamSlot` on spawn zones is a slot index, not a team ID: teams are assigned
to slots at match start so the same level works for teams of 1 or 4-6.

Placeholder: no loader exists yet and the schema is not frozen.
