(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_annotation
  (type_identifier) @name.reference.type) @reference.type

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(interface_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; Call/reference patterns grafted from aider's javascript-tags.scm: the TypeScript
; grammar is a superset of JavaScript's node types, and aider's typescript query
; captures definitions and type references but no calls at all.
(
  (call_expression
    function: (identifier) @name.reference.call) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
  arguments: (_) @reference.call)

; Functions assigned to a const, added 2026-10-18. aider's javascript-tags.scm has this
; pattern; its typescript one does not, so `const f = () => {}` was invisible as a
; definition - and in modern TypeScript and React that is most functions. Found by sampling
; unresolved call sites: `pushBlock` in src/ui/App.tsx had 75 call sites and no definition.
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

; The React higher-order-component case: `const f = useCallback(() => {}, [])`.
;
; Narrowed to named wrappers on 2026-10-18 after the acceptance measurement caught the broader
; version red-handed. Matching on the mere PRESENCE of an arrow-function argument also matched
; `const uninstall = installGcWatchdog(500, () => {}, deps)` and `const call = rows.find((e) =>
; e.kind === 'x')` - both of which bind a VALUE, not a function definition - and every call to
; `uninstall()` anywhere in the repository was then attributed to that local const. It was the
; single largest remaining source of wrong answers, and it was a pattern I had added myself one
; step earlier. Naming the wrappers is less clever and actually correct.
(
  (variable_declarator
    name: (identifier) @name.definition.function
    value: (call_expression
      function: (identifier) @_wrapper
      arguments: (arguments (arrow_function)))) @definition.function
  (#match? @_wrapper "^(useCallback|useMemo|memo|forwardRef)$")
)

; Callback-typed properties and parameters, added 2026-10-18 from the acceptance measurement.
; The residual precision errors were almost all of one shape: `emit()`, `onEntry()`,
; `toolPolicy()`, `resolve()` and `onToken()` are called through a property or a parameter that
; holds a function, and with no pattern matching those the only candidate left was an unrelated
; top-level definition sharing the name - so the graph answered confidently and wrongly.
;
; Restricted to `function_type` deliberately. Capturing every interface property would flood the
; definition table with field names and make far more names ambiguous; capturing only the ones
; that hold a function adds exactly the callers that were missing.
(property_signature
  name: (property_identifier) @name.definition.function
  type: (type_annotation (function_type))) @definition.function

(required_parameter
  pattern: (identifier) @name.definition.function
  type: (type_annotation (function_type))) @definition.function

(optional_parameter
  pattern: (identifier) @name.definition.function
  type: (type_annotation (function_type))) @definition.function
