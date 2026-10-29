// Package readme inserts or updates a card snippet in a Markdown file.
//
// The snippet sits between marker comments so a later run replaces it in
// place instead of appending a second copy:
//
//	<!-- ghcard:octocat -->
//	[![GitHubCard for octocat](…)](https://github.com/octocat)
//	<!-- /ghcard:octocat -->
package readme

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"
)

// Edit says what Upsert did.
type Edit string

const (
	Created   Edit = "created"
	Inserted  Edit = "inserted"
	Updated   Edit = "updated"
	Unchanged Edit = "unchanged"
)

var unsafeID = regexp.MustCompile(`[^a-z0-9._/-]`)

// MarkerID derives a stable marker id from a card subject.
func MarkerID(subject string) string {
	return unsafeID.ReplaceAllString(strings.ToLower(subject), "-")
}

func markers(id string) (string, string) {
	return fmt.Sprintf("<!-- ghcard:%s -->", id), fmt.Sprintf("<!-- /ghcard:%s -->", id)
}

// Apply returns content with the block for id set to snippet.
func Apply(content, id, snippet string) (string, Edit) {
	start, end := markers(id)
	block := start + "\n" + strings.TrimSpace(snippet) + "\n" + end

	i := strings.Index(content, start)
	if i >= 0 {
		j := strings.Index(content[i:], end)
		if j >= 0 {
			j += i + len(end)
			next := content[:i] + block + content[j:]
			if next == content {
				return content, Unchanged
			}
			return next, Updated
		}
	}

	// Not present yet: put it directly after the first heading if there is
	// one, otherwise at the top, which is where a profile card belongs.
	lines := strings.SplitAfter(content, "\n")
	for k, line := range lines {
		if strings.HasPrefix(line, "# ") {
			head := strings.Join(lines[:k+1], "")
			if !strings.HasSuffix(head, "\n") {
				head += "\n"
			}
			return head + "\n" + block + "\n" + strings.Join(lines[k+1:], ""), Inserted
		}
	}
	if content == "" {
		return block + "\n", Inserted
	}
	return block + "\n\n" + content, Inserted
}

// Upsert edits the file at path, creating it if needed.
func Upsert(path, id, snippet string) (Edit, error) {
	raw, err := os.ReadFile(path)
	existed := true
	if errors.Is(err, fs.ErrNotExist) {
		existed = false
	} else if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	next, edit := Apply(string(raw), id, snippet)
	if edit == Unchanged {
		return Unchanged, nil
	}
	mode := fs.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(path, []byte(next), mode); err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	if !existed {
		return Created, nil
	}
	return edit, nil
}
