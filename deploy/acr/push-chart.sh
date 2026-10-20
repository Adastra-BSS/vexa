#!/bin/sh
# Runs as the last acb.yaml step, inside alpine/helm: packages the chart versioned
# <chart-version>-<channel>-<commit> and pushes it as an OCI artifact. Lives as a file rather
# than inline in acb.yaml because ACB substitutes $-prefixed aliases in the task YAML, which
# mangles ordinary shell variables there.
#
# The jana-pilot channel is the prod build and goes to helm/vexa, the repository every prod and
# ci deploy anchors on by "newest tag". Every other channel goes to helm-dev/vexa, so a personal
# build can never become the newest prod chart.
set -e

REGISTRY=$1
COMMIT=$2
CHANNEL=$3
[ -n "$REGISTRY" ] && [ -n "$COMMIT" ] && [ -n "$CHANNEL" ] \
    || { echo "usage: push-chart.sh <registry> <commit> <channel>" >&2; exit 1; }

case "$CHANNEL" in
    jana-pilot) CHART_PATH=helm ;;
    attend-dev-?*) CHART_PATH=helm-dev ;;
    *) echo "channel must be jana-pilot or attend-dev-<id>, got: $CHANNEL" >&2; exit 1 ;;
esac

# The task's registry credentials land in the shared docker config; helm reads the same file.
CONFIG="${DOCKER_CONFIG:-/root/.docker}/config.json"
if [ -f "$CONFIG" ]; then
    export HELM_REGISTRY_CONFIG="$CONFIG"
else
    echo "warning: no docker config at $CONFIG - helm push will rely on ambient auth" >&2
fi

VER=$(sed -n 's/^version: *//p' deploy/helm/charts/vexa/Chart.yaml)
[ -n "$VER" ] || { echo "could not read version from Chart.yaml" >&2; exit 1; }

helm package deploy/helm/charts/vexa --version "$VER-$CHANNEL-$COMMIT" -d /tmp/chart
helm push "/tmp/chart/vexa-$VER-$CHANNEL-$COMMIT.tgz" "oci://$REGISTRY/$CHART_PATH"
