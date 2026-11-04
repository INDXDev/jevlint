# Records docs/assets/demo.gif. Run from the repository root: vhs docs/assets/demo/demo.tape
# Uses the stand-in ./jevlint beside this file, so the output is simulated.
Output docs/assets/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1100
Set Height 600
Set Padding 24
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 10
Set TypingSpeed 45ms
Set Framerate 24

Hide
Type `export PATH="$PWD/docs/assets/demo:$PATH" JEVLINT_DEMO_STATE="$(mktemp -u)" PS1='\[\e[36m\]shop-api\[\e[0m\] $ '`
Enter
Ctrl+L
Show

Sleep 600ms
Type "jevlint audit"
Sleep 300ms
Enter
Sleep 5s

Ctrl+L
Type "jevlint explain src/orders/process.ts"
Sleep 300ms
Enter
Sleep 6s

Ctrl+L
Type "jevlint fix --agent claude --yes"
Sleep 300ms
Enter
Sleep 9s

Ctrl+L
Type "jevlint audit"
Sleep 300ms
Enter
Sleep 6s
