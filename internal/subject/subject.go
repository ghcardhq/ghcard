// Package subject parses the card subjects and filters shared by the CLI
// and the MCP server, so both accept exactly the same input.
package subject

import (
	"fmt"
	"strings"
)

// Parse turns "user", "owner/repo", or a GitHub URL for either into its parts.
// repo is empty for a profile. Accepted URL forms: http(s)://, optional www.,
// a trailing slash, and a trailing .git on the repository.
func Parse(input string) (username, repo string, err error) {
	s := strings.TrimSpace(input)
	lower := strings.ToLower(s)
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(lower, prefix) {
			s, lower = s[len(prefix):], lower[len(prefix):]
		}
	}
	for _, host := range []string{"www.github.com/", "github.com/"} {
		if strings.HasPrefix(lower, host) {
			s = s[len(host):]
			break
		}
	}
	s = strings.TrimSuffix(s, "/")
	parts := strings.Split(s, "/")
	switch {
	case len(parts) == 1 && parts[0] != "":
		return parts[0], "", nil
	case len(parts) == 2 && parts[0] != "" && parts[1] != "":
		return parts[0], strings.TrimSuffix(parts[1], ".git"), nil
	}
	return "", "", fmt.Errorf("%q is not a GitHub user or owner/repo", input)
}

// HasAllWidgets reports whether have contains every type in want, ignoring case.
func HasAllWidgets(have, want []string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			if strings.EqualFold(h, w) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
