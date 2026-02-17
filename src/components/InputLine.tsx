import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

type InputLineProps = {
  onSubmit: (text: string) => void;
};

export function InputLine({ onSubmit }: InputLineProps) {
  const [value, setValue] = useState("");

  return (
    <Box>
      <Text color="green">{"you> "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          onSubmit(v);
          setValue("");
        }}
      />
    </Box>
  );
}
