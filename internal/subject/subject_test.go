package subject

import "testing"

func TestParse(t *testing.T) {
	cases := map[string][2]string{
		"octocat":                                    {"octocat", ""},
		"octocat/hello-world":                        {"octocat", "hello-world"},
		"https://github.com/octocat/hello-world":     {"octocat", "hello-world"},
		"http://github.com/octocat":                  {"octocat", ""},
		"https://www.github.com/octocat/hello-world": {"octocat", "hello-world"},
		"github.com/octocat/":                        {"octocat", ""},
		"GitHub.com/octocat/hello-world.git":         {"octocat", "hello-world"},
		"  octocat  ":                                {"octocat", ""},
		"octocat/":                                   {"octocat", ""},
	}
	for in, want := range cases {
		u, r, err := Parse(in)
		if err != nil || u != want[0] || r != want[1] {
			t.Errorf("Parse(%q) = %q, %q, %v; want %v", in, u, r, err, want)
		}
	}
	for _, in := range []string{"", "a/b/c", "/repo", "https://github.com/"} {
		if _, _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q): expected an error", in)
		}
	}
}

func TestHasAllWidgets(t *testing.T) {
	if !HasAllWidgets([]string{"avatar", "streak"}, []string{"Streak"}) {
		t.Error("case-insensitive match expected")
	}
	if HasAllWidgets([]string{"avatar"}, []string{"avatar", "streak"}) {
		t.Error("missing widget must fail")
	}
}
