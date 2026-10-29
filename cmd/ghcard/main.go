// Command ghcard generates GitHubCard profile and repository cards.
package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/Cactusinhand/GithubCard-web/cli/internal/cmd"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	code := cmd.Execute(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
