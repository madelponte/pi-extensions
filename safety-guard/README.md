# Safety Guard

Confirms before destructive shell commands and before Git commands that may change repository state. Common read-only Git commands such as `status`, `diff`, `log`, and `show` run without confirmation. Unknown Git subcommands are treated as mutating. In non-UI modes, commands requiring approval are blocked.
