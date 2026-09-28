# Superset, plus the one driver it needs to reach this platform's database.
#
# The upstream image ships no database drivers at all — Superset 6 slimmed them
# out and expects each deployment to install the one it actually uses. Without
# psycopg2 the container cannot even read its own metadata database and exits
# before serving anything ("No module named 'psycopg2'").
#
# Baked in at build time rather than installed by the container's own
# pip-install hook on boot: a runtime install makes every start depend on the
# network and on an unpinned resolve, which turns a package-index hiccup into a
# service that will not come up.
FROM apache/superset:6.1.0

USER root
# uv is the installer this image ships; pip is not present inside the venv.
# psycopg2  - the platform database driver; without it Superset cannot read its
#             own metadata and exits before serving anything.
# authlib   - required by Flask-AppBuilder the moment AUTH_TYPE is AUTH_OAUTH.
#             It is imported at security-manager construction, so a missing
#             authlib is not a failed login: every worker fails to boot.
RUN uv pip install --python /app/.venv/bin/python --no-cache         psycopg2-binary==2.9.10         Authlib==1.3.2
USER superset
