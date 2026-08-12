#!/bin/sh
# Blocks a commit that would introduce either of two failures that have
# actually happened in these repos:
#
#   1. A NUL byte silently written into a text file — invisible in an editor
#      and in most diffs, but git then treats the file as binary and every
#      future `git diff` on it goes dark. (Happened once: an AI coding tool
#      wrote a raw 0x00 byte where an ordinary space belonged, in a string
#      literal, in a file nobody was looking at byte-by-byte.)
#   2. An unresolved merge-conflict marker committed straight into a file —
#      breaks the build with an opaque syntax error far from the real cause.
#      (Happened once: a merge left <<<<<<< / >>>>>>> in providers.ts and
#      esbuild failed with "Unexpected <<".)
#
# Runs only on staged files, so it's fast. `git commit --no-verify` skips it
# if you ever need to.
#
# NOTE on the NUL check: this was originally `grep -I`, which is backwards —
# grep's -I means "treat a file it detects as binary as a NON-match", i.e. it
# SKIPS exactly the files a NUL byte would make it classify as binary. That
# made the check self-defeating: the first real NUL-byte corruption sailed
# through two commits before anyone noticed, because the tool built to catch
# it never actually searched the corrupted file. Comparing byte counts
# before/after stripping NULs has no such binary-detection step to fool.

bad=0

for f in $(git diff --cached --name-only --diff-filter=ACM); do
	case "$f" in
	*.png | *.jpg | *.jpeg | *.gif | *.svg | *.ico | *.woff | *.woff2 | *.ttf | *.eot | *.webp)
		continue
		;;
	esac
	[ -f "$f" ] || continue

	orig_size=$(wc -c <"$f")
	stripped_size=$(tr -d '\000' <"$f" | wc -c)
	if [ "$orig_size" != "$stripped_size" ]; then
		echo "✗ $f contains a NUL byte — likely silent corruption, not intentional binary content." >&2
		bad=1
	fi

	if grep -anE '^(<<<<<<<|>>>>>>>)( |$)' -- "$f" >/dev/null 2>&1; then
		echo "✗ $f has an unresolved merge-conflict marker:" >&2
		grep -anE '^(<<<<<<<|>>>>>>>)( |$)' -- "$f" >&2
		bad=1
	fi
done

if [ "$bad" -eq 1 ]; then
	echo "" >&2
	echo "Commit blocked. Fix the file(s) above, or run 'git commit --no-verify' to skip this check just this once." >&2
	exit 1
fi

exit 0
