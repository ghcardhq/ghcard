package readme

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const snippet = "[![GitHubCard for octocat](https://githubcard.com/g/abc.svg)](https://github.com/octocat)"

func TestApplyInsertsAfterFirstHeading(t *testing.T) {
	got, edit := Apply("# Hello\n\nIntro text.\n", "octocat", snippet)
	if edit != Inserted {
		t.Fatalf("edit = %s, want inserted", edit)
	}
	want := "# Hello\n\n<!-- ghcard:octocat -->\n" + snippet + "\n<!-- /ghcard:octocat -->\n\nIntro text.\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestApplyInsertsAtTopWithoutHeading(t *testing.T) {
	got, _ := Apply("Just text.\n", "octocat", snippet)
	if !strings.HasPrefix(got, "<!-- ghcard:octocat -->\n") || !strings.HasSuffix(got, "\n\nJust text.\n") {
		t.Fatalf("unexpected placement:\n%s", got)
	}
}

func TestApplyReplacesExistingBlockOnly(t *testing.T) {
	old := "# T\n\n<!-- ghcard:octocat -->\nOLD\n<!-- /ghcard:octocat -->\n\nKeep me.\n"
	got, edit := Apply(old, "octocat", snippet)
	if edit != Updated {
		t.Fatalf("edit = %s, want updated", edit)
	}
	if strings.Contains(got, "OLD") || !strings.Contains(got, "Keep me.") || strings.Count(got, "<!-- ghcard:octocat -->") != 1 {
		t.Fatalf("bad replacement:\n%s", got)
	}

	again, edit := Apply(got, "octocat", snippet)
	if edit != Unchanged || again != got {
		t.Fatalf("second apply should be unchanged, got %s", edit)
	}
}

func TestApplyKeepsOtherSubjectsBlocks(t *testing.T) {
	doc, _ := Apply("# T\n", "octocat", snippet)
	doc, _ = Apply(doc, "octocat/hello-world", "[repo](x)")
	if strings.Count(doc, "<!-- ghcard:") != 2 {
		t.Fatalf("expected two blocks:\n%s", doc)
	}
}

func TestMarkerIDIsSafe(t *testing.T) {
	if got := MarkerID("OctoCat/Hello World-->"); got != "octocat/hello-world---" {
		t.Fatalf("MarkerID = %q", got)
	}
}

func TestUpsertCreatesAndKeepsMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "README.md")
	edit, err := Upsert(path, "octocat", snippet)
	if err != nil || edit != Created {
		t.Fatalf("Upsert new = %s, %v", edit, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if edit, err = Upsert(path, "octocat", "[![x](y)](z)"); err != nil || edit != Updated {
		t.Fatalf("Upsert existing = %s, %v", edit, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode changed to %v", info.Mode().Perm())
	}
}
