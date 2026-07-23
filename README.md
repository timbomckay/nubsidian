# Nubsidian (production build)

This is the auto-built `production` branch. Everything is bundled — there is
**no** `npm install` step and no `node_modules`.

## Run it

    cp config.example.json config.json   # then edit: set your port + roots
    node server.js                        # or: npm start

The server creates a default `config.json` for you if you skip the copy.

> Built from the `main` branch by `build-production.js`. Don't edit this
> branch by hand — changes here are overwritten on the next push to `main`.
