#!/bin/sh
# Rebuild ../theme.css from theme.src.css ("§" is shorthand for html[data-theme="pop"]).
cd "$(dirname "$0")" && sed 's/§/html[data-theme="pop"]/g' theme.src.css > ../theme.css && ! grep -q "§" ../theme.css && echo "theme.css rebuilt"
