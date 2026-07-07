#!/bin/sh
# Push apps-script/ to the Apps Script project and redeploy the LIVE web app
# (the same /exec the widget calls) in one step — no editor copy-paste.
#
# One-time setup:
#   npm i -g @google/clasp
#   open https://script.google.com/home/usersettings  # turn ON the Apps Script API
#   clasp login                                        # authorize in the browser
#
# Then, after editing apps-script/Code.gs, just run:  sh deploy-backend.sh
set -e

DEPLOYMENT_ID="AKfycbxWJC_Y2T37JZIvZszOQw9akjr3PbOKsfIkVzJCrweSioxoYfXzoolv_4y8phA8hxcTIw"

echo "→ Pushing apps-script/ to Apps Script…"
clasp push -f

echo "→ Redeploying the live web app…"
clasp deploy -i "$DEPLOYMENT_ID" -d "deploy-backend.sh $(date -u +%Y-%m-%dT%H:%MZ)"

echo "✓ Done. The /exec URL now serves the latest Code.gs."
