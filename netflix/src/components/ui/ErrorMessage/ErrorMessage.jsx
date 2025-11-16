import { Box, Typography } from '@mui/material';
import React from 'react';

const ErrorMessage = () => {
  return (
    <Box
      display="flex"
      flexDirection="column"
      alignItems="center"
      margin="auto"
    >
      <Typography variant="h6" style={{textAlign: 'center'}}>
        Произошла ошибка... <br/>
        Попробуйте обновить страницу.
      </Typography>
    </Box>
  );
};

export default ErrorMessage;
