#!/bin/sh
set -eu

invalid_output() {
    printf 'Expected the Bodhi AppImage output path from Tauri\n' >&2
    exit 1
}

# linuxdeploy 4b24a49 honors PATCHELF and applies RPATH changes to existing
# usr/bin executables and every ELF below usr/lib, including bundled runtimes.
case "$#:${1-}" in
    2:--print-rpath)
        exec /usr/bin/patchelf "$@"
        ;;
    3:--set-rpath)
        # Tauri 2.5.0 sets OUTPUT on linuxdeploy to the final AppImage path.
        # The sibling AppDir has the same product name, including the space.
        output=${OUTPUT-}
        case "$output" in /*) ;; *) invalid_output ;; esac
        case "${output##*/}" in
            "Bodhi AI_"*.AppImage) ;;
            *) invalid_output ;;
        esac
        appdir=$(realpath -e -- "${output%/*}/Bodhi AI.AppDir")
        file=$(realpath -e -- "$3")
        case "$file" in
            "$appdir/usr/bin/bamboo"|"$appdir/usr/lib/Bodhi AI/browser-runtime/"*)
                printf 'Preserving locked AppImage input %s\n' "$file" >&2
                exit 0
                ;;
        esac
        exec /usr/bin/patchelf "$@"
        ;;
    *)
        printf 'Unsupported linuxdeploy patchelf invocation\n' >&2
        exit 1
        ;;
esac
