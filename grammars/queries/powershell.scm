; PowerShell tag query (plan 0006 K2). Authored here: neither upstream (airbus-cert/tree-sitter-powershell)
; nor the @vscode/tree-sitter-wasm payload that ships the grammar carries a tags.scm.
;
; A script's call graph is its command invocations, as with bash: `Get-Thing -Name x` is a call to the
; function `Get-Thing`. Built-in cmdlets (`Write-Output`) are captured too and simply resolve to
; nothing in the repository.

(function_statement
  (function_name) @name.definition.function) @definition.function

; The first named child is the class name; any further `simple_name` children are base types.
(class_statement
  . (simple_name) @name.definition.class) @definition.class

(class_method_definition
  (simple_name) @name.definition.method) @definition.method

(command
  (command_name) @name.reference.call) @reference.call

; `$x.Start(80)`, `[Server]::Create()`: a method invocation, as Java captures it.
(invokation_expression
  (member_name (simple_name) @name.reference.method)
  (argument_list)) @reference.call
