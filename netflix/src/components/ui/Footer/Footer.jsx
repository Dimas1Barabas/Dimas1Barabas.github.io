import { Stack, Typography } from '@mui/material';
import React from 'react';

const Footer = () => {
  return (
    <Stack
      component="footer"
      sx={{
        paddingTop: 4,
        paddingBottom: 4,
        flexDirection: { sm: 'row' },
        justifyContent: { sm: 'space-between' },
        alignItems: { sm: 'center' },
        marginTop: 'auto',
      }}
    >
      <Typography variant="body2" color="text.secondary">
        &copy; {new Date().getFullYear()} &laquo;Netflix&raquo; 18+ <br />
        Данный сайт создан исключительно в обучающих целях. <br />
        Все права принадлежат правообладателям.
      </Typography>
      <Typography variant="h4" color="primary.main">
        Netflix
      </Typography>
    </Stack>
  );
};

export default Footer;
