(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(protocol_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(class_declaration
    (class_body
        [
            (function_declaration
                name: (simple_identifier) @name.definition.method
            )
            (subscript_declaration
                (parameter (simple_identifier) @name.definition.method)
            )
            (init_declaration "init" @name.definition.method)
            (deinit_declaration "deinit" @name.definition.method)
        ]
    )
) @definition.method

(protocol_declaration
    (protocol_body
        [
            (protocol_function_declaration
                name: (simple_identifier) @name.definition.method
            )
            (subscript_declaration
                (parameter (simple_identifier) @name.definition.method)
            )
            (init_declaration "init" @name.definition.method)
        ]
    )
) @definition.method

(class_declaration
    (class_body
        [
            (property_declaration
                (pattern (simple_identifier) @name.definition.property)
            )
        ]
    )
) @definition.property

(property_declaration
    (pattern (simple_identifier) @name.definition.property)
) @definition.property

(function_declaration
    name: (simple_identifier) @name.definition.function) @definition.function

; Call references, authored 2026-10-18. aider's swift-tags.scm captures 12
; definition patterns and no references. Swift wraps arguments in a call_suffix
; rather than an argument_list, and method calls go through navigation_expression
; -> navigation_suffix, so neither C-style form matches.
(call_expression
  (simple_identifier) @name.reference.call) @reference.call

(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @name.reference.call))) @reference.call
