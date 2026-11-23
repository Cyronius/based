#!/usr/bin/env bash
# Wrap the release's Tauri payload in a native pacman package. Run as a regular Arch user.
set -euo pipefail
if [[ $# != 1 ]]; then
  echo "Usage: $0 path/to/based-VERSION-fedora-x86_64.rpm" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
rpm=$(realpath -e -- "$1")
name=${rpm##*/}
if [[ ! $name =~ ^based-([0-9]+\.[0-9]+\.[0-9]+)-fedora-x86_64\.rpm$ ]]; then
  echo "Expected an x86_64 based release RPM, got $name" >&2
  exit 1
fi
version=${BASH_REMATCH[1]}
read -r checksum filename < "$rpm.sha256"
if [[ ! $checksum =~ ^[[:xdigit:]]{64}$ || $filename != "$name" ]]; then
  echo "Invalid release checksum file: $rpm.sha256" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
ln -s "$rpm" "$name"
sed -e "s/@VERSION@/$version/" -e "s/@RPM_SHA256@/$checksum/" \
  "$root/scripts/arch/PKGBUILD.in" > PKGBUILD
# Dependency checks belong to the install test. makepkg only copies the verified binary payload.
PKGEXT=.pkg.tar.zst PKGDEST="$work" makepkg --nodeps
package="based-$version-1-x86_64.pkg.tar.zst"
sha256sum "$package" > "$package.sha256"
mkdir -p "$root/dist"
mv -- "$package" "$package.sha256" "$root/dist/"
echo "Arch package: $root/dist/$package"
