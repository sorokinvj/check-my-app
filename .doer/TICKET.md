# www.checkmyapp.dev does not resolve

GitHub issue: sorokinvj/check-my-app#6

`www.checkmyapp.dev` does not resolve. Anyone who types the www form, or is handed it by a client that adds it, lands nowhere.

**How to know it is gone.** `www.checkmyapp.dev` reaches the site the same as the bare domain.

**Note:** this is DNS, not code — it may not be the doer's to fix, and may need the owner at the registrar.

The other half of this ticket — `/sitemap.xml` returning 404 while `/robots.txt` returned 200 — is done: the sitemap now answers 200 and lists the public pages only, since a verdict lives on an unguessable permalink that is the customer's to share or not.

Source ticket: CHE-108 · https://linear.app/joblander/issue/CHE-108
