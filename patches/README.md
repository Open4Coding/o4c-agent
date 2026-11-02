# Ink patch

`ink+8.0.0.patch` is the record of what o4c changes in Ink 8.0.0: the frame clip (a live frame is
never as tall as the window) and separate writes for static output and the frame. See the comments
inside the patch.

Since 2026-11-02 the patch is not applied at install time any more. The patched Ink ships as
`vendor/ink-8.0.0-o4c.1.tgz` (Ink is MIT), installed through `"ink": "file:vendor/..."` and bundled
into the published package (`bundleDependencies`), so a user's install needs no install script -
npm 11 warns about those on global installs, and `--ignore-scripts` installs skipped them.

To change the patch: edit `node_modules/ink/build/*.js`, regenerate this diff against a pristine
`ink@8.0.0` (`npm pack ink@8.0.0`), then rebuild the vendored tarball from the edited package with
the version bumped (`8.0.0-o4c.N`) and update `package.json`.
